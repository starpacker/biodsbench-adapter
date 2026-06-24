import { isAbsolute, relative, resolve } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  isEvaluationNetworkDisabled,
  isEvaluationNetworkToolName,
} from './networkPolicy.js'
import type { EvaluationNetworkPolicy, TaskRun } from './types.js'

export type HarnessCanUseToolInput = {
  taskRun: TaskRun
  allowedReadRoots?: string[]
  networkPolicy?: EvaluationNetworkPolicy
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READ_PATH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const FORBIDDEN_PATH_PARTS = [
  '.judge_private',
  'evaluation',
  'std_code',
  'ground_truth',
  'reference_outputs',
  'private',
]
const DANGEROUS_BASH_PATTERNS = [
  /\bsudo\b/i,
  /\bapt(?:-get)?\b/i,
  /\bconda\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bpython(?:3)?\s+-m\s+pip\s+install\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\b/i,
]
const BASH_CONTROL_OPERATORS = new Set(['&&', '||', '|', ';', '&'])
const BASH_REDIRECT_OPERATORS = new Set(['>', '>>'])
const BASH_WRITE_COMMANDS = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'ln',
  'tee',
  'chmod',
  'chown',
  'chgrp',
])
const BASH_DIRECT_READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'ls',
])
const BASH_PATH_SCANNED_COMMANDS = new Set([
  ...BASH_DIRECT_READ_COMMANDS,
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'find',
  'python',
  'python3',
  'bash',
  'sh',
  'timeout',
])

function normalizeForCompare(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(path: string, parent: string): boolean {
  const child = normalizeForCompare(path)
  const base = normalizeForCompare(parent)
  return child === base || child.startsWith(`${base}\\`) || child.startsWith(`${base}/`)
}

function logicalClaudeWorkspacePath(path: string, taskRun: TaskRun): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/Users\/dev\/workspace(?:-[^/]+)?(?:\/(.*))?$/)
  if (!match) return undefined
  const suffix = match[1] ?? ''
  return suffix ? resolve(taskRun.runDir, suffix) : taskRun.runDir
}

function resolveHarnessPath(
  cwd: string,
  candidate: string,
  taskRun: TaskRun,
): string | undefined {
  if (!candidate || hasDynamicPathSyntax(candidate)) return undefined
  return logicalClaudeWorkspacePath(candidate, taskRun) ?? resolve(cwd, candidate)
}

function isForbiddenPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return FORBIDDEN_PATH_PARTS.find(part => normalized.split('/').includes(part))
}

function isKnownTaskMaterialsPath(path: string, taskRun: TaskRun): boolean {
  const absolute = resolveHarnessPath(taskRun.runDir, path, taskRun)
  return absolute
    ? isInside(absolute, resolve(taskRun.publicDir, 'known_tasks'))
    : false
}

function isAllowedKnownTaskForbiddenPath(
  path: string,
  forbidden: string,
  taskRun: TaskRun,
): boolean {
  return forbidden === 'std_code' && isKnownTaskMaterialsPath(path, taskRun)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pathValues(input: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value) values.push(value)
  }
  return values
}

function deny(message: string, toolUseID?: string): PermissionDecision {
  return {
    behavior: 'deny',
    message,
    toolUseID,
    decisionReason: { type: 'other', reason: message },
  }
}

function allow(input: Record<string, unknown>): PermissionDecision {
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'harness source-native policy allow' },
  }
}

function denyIfBashUnsafe(command: string, taskRun: TaskRun): string | undefined {
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return `Bash command rejected by harness policy: ${pattern.source}`
    }
  }
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  for (const part of FORBIDDEN_PATH_PARTS) {
    if (commandReferencesForbiddenPartOutsideKnownTasks(command, part, taskRun)) {
      return `Bash command rejected: command references forbidden path segment "${part}".`
    }
  }
  const runParent = resolve(taskRun.runDir, '..')
  if (
    normalized.includes('/output/runs/') ||
    normalized.includes('\\output\\runs\\'.toLowerCase())
  ) {
    return 'Bash command rejected: use run-local public/, workspace/, outputs/, or logs/agent paths only.'
  }
  if (command.includes(runParent) && !command.includes(taskRun.runDir)) {
    return 'Bash command rejected: command references paths outside the current run.'
  }
  return undefined
}

function configuredMaxBashTimeoutMs(): number | undefined {
  const raw = process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function shellTimeoutDurationMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = value.match(/^(\d+(?:\.\d+)?)([smhd]?)$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const unit = match[2]?.toLowerCase() ?? ''
  const multiplier =
    unit === 'm' ? 60_000 :
    unit === 'h' ? 3_600_000 :
    unit === 'd' ? 86_400_000 :
    1_000
  return amount * multiplier
}

function shellTimeoutDurations(command: string): number[] {
  const durations: number[] = []
  const parts = tokenizeBashForHarness(command)
  let argv: string[] = []

  const processArgv = () => {
    if (argv.length === 0) return
    const commandAndArgs = commandNameAndArgs(argv)
    argv = []
    if (!commandAndArgs) return
    const { name, args } = commandAndArgs
    if (name !== 'timeout' && name !== 'gtimeout') return

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue
      if (arg === '-k' || arg === '--kill-after') {
        i++
        continue
      }
      if (arg.startsWith('--kill-after=')) continue
      if (arg.startsWith('-')) continue
      const parsed = shellTimeoutDurationMs(arg)
      if (parsed !== undefined) durations.push(parsed)
      return
    }
  }

  for (const part of parts) {
    if (BASH_CONTROL_OPERATORS.has(part) || BASH_REDIRECT_OPERATORS.has(part)) {
      processArgv()
      continue
    }
    argv.push(part)
  }
  processArgv()
  return durations
}

function isPythonCommandName(name: string): boolean {
  return name === 'python' || name === 'python3' || /^python\d+(?:\.\d+)?$/.test(name)
}

function isBoundedShellTimeoutCommand(argv: string[]): boolean {
  const commandAndArgs = commandNameAndArgs(argv)
  if (!commandAndArgs) return false
  const { name, args } = commandAndArgs
  if (name !== 'timeout' && name !== 'gtimeout') return false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '-k' || arg === '--kill-after') {
      i++
      continue
    }
    if (arg.startsWith('--kill-after=')) continue
    if (arg.startsWith('-')) continue
    return shellTimeoutDurationMs(arg) !== undefined && args.slice(i + 1).length > 0
  }
  return false
}

function commandChunksInShellSegment(segment: string[]): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []

  const flush = () => {
    if (chunk.length > 0) {
      chunks.push(chunk)
      chunk = []
    }
  }

  for (let i = 0; i < segment.length; i++) {
    const token = segment[i]
    if (!token) continue
    if (token === '|') {
      flush()
      continue
    }
    if (BASH_REDIRECT_OPERATORS.has(token)) {
      i++
      continue
    }
    chunk.push(token)
  }
  flush()
  return chunks
}

function shellCommandContainsCleanup(command: string): boolean {
  return /(^|[;&|\n]\s*)(?:kill|pkill|wait)\b/.test(command)
}

function segmentHasUnboundedBackgroundPython(segment: string[]): boolean {
  for (const chunk of commandChunksInShellSegment(segment)) {
    const commandAndArgs = commandNameAndArgs(chunk)
    if (!commandAndArgs) continue
    const { name, args } = commandAndArgs

    if (isBoundedShellTimeoutCommand(chunk)) continue

    if (name === 'nohup') {
      if (isBoundedShellTimeoutCommand(args)) continue
      const inner = commandNameAndArgs(args)
      if (inner && isPythonCommandName(inner.name)) return true
      continue
    }

    if (isPythonCommandName(name)) return true
  }
  return false
}

function denyIfBashUnboundedBackground(command: string): string | undefined {
  if (shellCommandContainsCleanup(command)) return undefined

  const parts = tokenizeBashForHarness(command)
  let segment: string[] = []

  const processSegment = (backgrounded: boolean): string | undefined => {
    if (!backgrounded || segment.length === 0) {
      segment = []
      return undefined
    }
    const hasUnboundedPython = segmentHasUnboundedBackgroundPython(segment)
    segment = []
    if (!hasUnboundedPython) return undefined
    return 'Bash command rejected: unbounded background Python/nohup process would bypass validation timeout; use a shell timeout within the validation cap or run it in the foreground for managed Bash output.'
  }

  for (const part of parts) {
    if (part === '&') {
      const reason = processSegment(true)
      if (reason) return reason
      continue
    }
    if (part === ';' || part === '&&' || part === '||') {
      const reason = processSegment(false)
      if (reason) return reason
      continue
    }
    segment.push(part)
  }

  return processSegment(false)
}

function denyIfBashTimeoutTooLong(toolInput: Record<string, unknown>): string | undefined {
  const maxTimeoutMs = configuredMaxBashTimeoutMs()
  if (!maxTimeoutMs) return undefined
  const timeout = toolInput.timeout
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > maxTimeoutMs) {
    return `Bash command rejected: requested timeout ${timeout}ms exceeds validation cap ${maxTimeoutMs}ms.`
  }
  const command = typeof toolInput.command === 'string' ? toolInput.command : ''
  for (const shellTimeout of shellTimeoutDurations(command)) {
    if (shellTimeout > maxTimeoutMs) {
      return `Bash command rejected: shell timeout ${shellTimeout}ms exceeds validation cap ${maxTimeoutMs}ms.`
    }
  }
  return undefined
}

function isAllowedRead(
  path: string,
  taskRun: TaskRun,
  allowedReadRoots: string[] = [],
): boolean {
  return (
    isInside(path, taskRun.publicDir) ||
    isInside(path, taskRun.workspaceDir) ||
    isInside(path, taskRun.outputsDir) ||
    isInside(path, resolve(taskRun.logsDir, 'agent')) ||
    allowedReadRoots.some(root => isInside(path, root))
  )
}

function isAllowedWrite(path: string, taskRun: TaskRun): boolean {
  return (
    isInside(path, taskRun.workspaceDir) ||
    isInside(path, taskRun.outputsDir) ||
    isInside(path, resolve(taskRun.logsDir, 'agent'))
  )
}

function relativeToRun(path: string, taskRun: TaskRun): string {
  const absolute = logicalClaudeWorkspacePath(path, taskRun) ?? resolve(path)
  const rel = relative(taskRun.runDir, absolute).replace(/\\/g, '/')
  return rel.startsWith('..') ? path : rel
}

function commandNameAndArgs(argv: string[]): { name: string; args: string[] } | undefined {
  let index = 0
  while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? '')) {
    index++
  }
  const name = argv[index]
  if (!name) return undefined
  return { name, args: argv.slice(index + 1) }
}

function tokenizeBashForHarness(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false

  const flush = () => {
    if (current) {
      tokens.push(current)
      current = ''
    }
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\n' || char === '\r') {
      flush()
      tokens.push(';')
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    const next = command[i + 1]
    if (char === '&' && next === '&') {
      flush()
      tokens.push('&&')
      i++
      continue
    }
    if (char === '&') {
      if (next && /\d/.test(next)) {
        current += char
        continue
      }
      flush()
      tokens.push('&')
      continue
    }
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      i++
      continue
    }
    if (char === '>' && /^\d+$/.test(current)) {
      // Shell fd redirects such as 2>/dev/null or 1>>logs/out are not argv.
      current = ''
    }
    if (char === '>' && next === '>') {
      flush()
      tokens.push('>>')
      i++
      continue
    }
    if (char === ';' || char === '|' || char === '>') {
      flush()
      tokens.push(char)
      continue
    }
    current += char
  }
  flush()
  return tokens
}

function pathContainsForbiddenPart(path: string, part: string): boolean {
  return path.replace(/\\/g, '/').toLowerCase().split('/').includes(part)
}

function commandReferencesForbiddenPartOutsideKnownTasks(
  command: string,
  part: string,
  taskRun: TaskRun,
): boolean {
  const normalizedPart = part.toLowerCase()
  if (!command.toLowerCase().includes(normalizedPart)) return false

  const parts = tokenizeBashForHarness(command)
  let currentCwd = taskRun.runDir
  let argv: string[] = []

  const processArgv = (): boolean => {
    if (argv.length === 0) return false
    const commandAndArgs = commandNameAndArgs(argv)
    argv = []
    if (!commandAndArgs) return false
    const { name, args } = commandAndArgs

    if (name === 'cd') {
      const target = args.find(arg => arg !== '--')
      currentCwd = target
        ? resolveShellPathForTaskRun(currentCwd, target, taskRun) ?? taskRun.publicDir
        : taskRun.runDir
      return false
    }

    for (const arg of args) {
      if (!pathContainsForbiddenPart(arg, normalizedPart)) continue
      const absolute = resolveShellPathForTaskRun(currentCwd, arg, taskRun)
      if (
        normalizedPart === 'std_code' &&
        absolute &&
        isInside(absolute, resolve(taskRun.publicDir, 'known_tasks'))
      ) {
        continue
      }
      return true
    }
    return false
  }

  for (const token of parts) {
    const partText = token.trim()
    if (!partText) continue
    if (BASH_CONTROL_OPERATORS.has(partText) || BASH_REDIRECT_OPERATORS.has(partText)) {
      if (processArgv()) return true
      continue
    }
    argv.push(partText)
  }

  return processArgv()
}

function hasDynamicPathSyntax(path: string): boolean {
  return /[$`*?[\]{}~]/.test(path)
}

function isPathLikeToken(value: string): boolean {
  if (!value) return false
  if (value === '.' || value === '..') return true
  if (value.includes('/') || value.includes('\\')) return true
  if (isAbsolute(value)) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (/^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(value)) return true
  return ['public', 'workspace', 'outputs', 'logs'].includes(value)
}

function isShellFdRedirectTarget(value: string): boolean {
  return /^&\d+$/.test(value)
}

function isNullDeviceRedirectTarget(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase()
  return normalized === '/dev/null' || normalized === 'nul'
}

function isAllowedRedirectOnlyTarget(value: string): boolean {
  return isShellFdRedirectTarget(value) || isNullDeviceRedirectTarget(value)
}

function staticPrefixBeforeDynamic(candidate: string): string | undefined {
  const dynamicIndex = candidate.search(/[$`*?[\]{}~]/)
  if (dynamicIndex < 0) return undefined
  const prefix = candidate.slice(0, dynamicIndex)
  const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'))
  if (slash < 0) return undefined
  return prefix.slice(0, slash) || undefined
}

function nonFlagArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--') {
      out.push(...args.slice(i + 1).filter(Boolean))
      break
    }
    if (arg.startsWith('-')) continue
    out.push(arg)
  }
  return out
}

function grepReadTargets(args: string[]): string[] {
  const targets: string[] = []
  let hasPattern = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === '--') {
      const rest = args.slice(i + 1).filter(Boolean)
      if (!hasPattern && rest.length > 0) {
        rest.shift()
      }
      targets.push(...rest)
      break
    }
    if (arg === '-e' || arg === '--regexp') {
      i++
      hasPattern = true
      continue
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      hasPattern = true
      continue
    }
    if (arg === '-f' || arg === '--file') {
      const patternFile = args[i + 1]
      if (patternFile) targets.push(patternFile)
      i++
      hasPattern = true
      continue
    }
    if (arg.startsWith('-f') && arg.length > 2) {
      targets.push(arg.slice(2))
      hasPattern = true
      continue
    }
    if (arg.startsWith('-')) continue
    if (!hasPattern) {
      hasPattern = true
      continue
    }
    targets.push(arg)
  }

  return targets.filter(isPathLikeToken)
}

function readTargetsForCommand(name: string, args: string[]): string[] {
  if (BASH_DIRECT_READ_COMMANDS.has(name)) {
    return nonFlagArgs(args)
  }

  if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    return grepReadTargets(args)
  }

  if (name === 'find') {
    const targets: string[] = []
    for (const arg of args) {
      if (!arg || arg === '--') continue
      if (arg.startsWith('-') || arg === '!' || arg === '(' || arg === ')') break
      targets.push(arg)
    }
    return targets
  }

  if (name === 'python' || name === 'python3' || /^python\d+(?:\.\d+)?$/.test(name)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue
      if (arg === '-c' || arg === '-m') {
        i++
        continue
      }
      if (arg.startsWith('-')) continue
      return isPathLikeToken(arg) ? [arg] : []
    }
    return []
  }

  if (!BASH_PATH_SCANNED_COMMANDS.has(name)) return []
  return nonFlagArgs(args).filter(isPathLikeToken)
}

function embeddedScanValuesForCommand(name: string, args: string[]): string[] {
  if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
    return [name, ...grepReadTargets(args)]
  }
  return [name, ...args]
}

function writeTargetsForCommand(name: string, args: string[]): string[] {
  const operands = nonFlagArgs(args)
  if (name === 'cp' || name === 'mv' || name === 'ln') {
    return operands.length > 0 ? [operands[operands.length - 1]!] : []
  }
  if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
    return operands.slice(1)
  }
  return operands
}

function resolveShellPath(cwd: string, candidate: string): string | undefined {
  if (!candidate || hasDynamicPathSyntax(candidate)) return undefined
  return resolve(cwd, candidate)
}

function resolveShellPathForTaskRun(
  cwd: string,
  candidate: string,
  taskRun: TaskRun,
): string | undefined {
  return resolveHarnessPath(cwd, candidate, taskRun)
}

function resolveDynamicShellPathPrefix(
  cwd: string,
  candidate: string,
): string | undefined {
  const prefix = staticPrefixBeforeDynamic(candidate)
  return prefix ? resolve(cwd, prefix) : undefined
}

function embeddedPathCandidates(value: string): string[] {
  const candidates: string[] = []
  for (const match of value.matchAll(/[A-Za-z0-9_.:@-]*(?:\.\.|\.[\\/]|[A-Za-z]:[\\/]|\/)[A-Za-z0-9_./\\:@~-]*/g)) {
    const candidate = match[0]
      .replace(/^[^A-Za-z0-9_.~\\/]+/, '')
      .replace(/[^A-Za-z0-9_.~\\/]+$/, '')
    if (isPathLikeToken(candidate) && isLikelyEmbeddedPath(candidate)) {
      candidates.push(candidate)
    }
  }
  return candidates
}

function isLikelyEmbeddedPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  if (normalized === '/') return false
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../') ||
    normalized.startsWith('~/') ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return true
  }
  if (['public/', 'workspace/', 'outputs/', 'logs/'].some(prefix => lower.startsWith(prefix))) {
    return true
  }
  if (FORBIDDEN_PATH_PARTS.some(part => lower.split('/').includes(part))) {
    return true
  }
  const baseName = normalized.split('/').pop() ?? ''
  return /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+$/.test(baseName)
}

function denyIfBashReadTargetDisallowed(
  candidate: string,
  cwd: string,
  taskRun: TaskRun,
  allowedReadRoots: string[] = [],
): string | undefined {
  const absolute =
    resolveShellPathForTaskRun(cwd, candidate, taskRun) ??
    resolveDynamicShellPathPrefix(cwd, candidate)
  if (!absolute) {
    if (isAllowedRead(cwd, taskRun, allowedReadRoots)) return undefined
    return `Bash command rejected: dynamic read target "${candidate}" would execute outside public/, workspace/, outputs/, or logs/agent.`
  }
  if (!isAllowedRead(absolute, taskRun, allowedReadRoots)) {
    return `Bash command rejected: read target must resolve under public/, workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`
  }
  return undefined
}

function denyIfBashWriteTargetDisallowed(
  candidate: string,
  cwd: string,
  taskRun: TaskRun,
): string | undefined {
  const absolute = resolveShellPathForTaskRun(cwd, candidate, taskRun)
  if (!absolute) {
    if (isInside(cwd, taskRun.publicDir)) {
      return `Bash command rejected: dynamic write path "${candidate}" would execute from public/.`
    }
    if (!isAllowedWrite(cwd, taskRun)) {
      return `Bash command rejected: dynamic write path "${candidate}" would execute outside workspace/, outputs/, or logs/agent.`
    }
    return undefined
  }
  if (isInside(absolute, taskRun.publicDir)) {
    return `Bash command rejected: write target resolves under public/: ${relativeToRun(absolute, taskRun)}.`
  }
  if (!isAllowedWrite(absolute, taskRun)) {
    return `Bash command rejected: write target must resolve under workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`
  }
  return undefined
}

function denyIfBashPathAccessDisallowed(
  command: string,
  taskRun: TaskRun,
  allowedReadRoots: string[] = [],
): string | undefined {
  const parts = tokenizeBashForHarness(command)
  let currentCwd = taskRun.runDir
  let argv: string[] = []

  const processArgv = (): string | undefined => {
    if (argv.length === 0) return undefined
    const commandAndArgs = commandNameAndArgs(argv)
    argv = []
    if (!commandAndArgs) return undefined
    const { name, args } = commandAndArgs

    if (name === 'cd') {
      const target = args.find(arg => arg !== '--')
      if (!target) {
        currentCwd = taskRun.runDir
        return undefined
      }
      const nextCwd = resolveShellPathForTaskRun(currentCwd, target, taskRun)
      if (!nextCwd || !(nextCwd === resolve(taskRun.runDir) || isAllowedRead(nextCwd, taskRun, allowedReadRoots))) {
        return `Bash command rejected: cd target must resolve under public/, workspace/, outputs/, or logs/agent; got ${target}.`
      }
      currentCwd = nextCwd
      return undefined
    }

    const readTargets = [
      ...readTargetsForCommand(name, args),
      ...embeddedScanValuesForCommand(name, args).flatMap(embeddedPathCandidates),
    ]
    for (const target of readTargets) {
      const reason = denyIfBashReadTargetDisallowed(target, currentCwd, taskRun, allowedReadRoots)
      if (reason) return reason
    }

    if (!BASH_WRITE_COMMANDS.has(name)) return undefined
    for (const target of writeTargetsForCommand(name, args)) {
      const reason = denyIfBashWriteTargetDisallowed(target, currentCwd, taskRun)
      if (reason) return reason
    }
    return undefined
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]?.trim()
    if (!part) continue

    if (BASH_CONTROL_OPERATORS.has(part)) {
      const reason = processArgv()
      if (reason) return reason
      continue
    }

    if (BASH_REDIRECT_OPERATORS.has(part)) {
      const argvReason = processArgv()
      if (argvReason) return argvReason
      const target = parts[i + 1]?.trim()
      if (target) {
        if (isAllowedRedirectOnlyTarget(target)) {
          i++
          continue
        }
        if (isPathLikeToken(target)) {
          const readReason = denyIfBashReadTargetDisallowed(target, currentCwd, taskRun, allowedReadRoots)
          if (readReason) return readReason
        }
        const reason = denyIfBashWriteTargetDisallowed(target, currentCwd, taskRun)
        if (reason) return reason
      }
      i++
      continue
    }

    argv.push(part)
  }

  return processArgv()
}

export function createHarnessCanUseTool(input: HarnessCanUseToolInput): CanUseToolFn {
  const { taskRun } = input
  const allowedReadRoots = (input.allowedReadRoots ?? []).map(root => resolve(root))
  const networkDisabled = isEvaluationNetworkDisabled(input)

  return async (tool, rawInput, _toolUseContext, _assistantMessage, toolUseID) => {
    const toolInput = asRecord(rawInput)
    const toolName = tool.name

    if (networkDisabled && isEvaluationNetworkToolName(toolName)) {
      return deny(
        `${toolName} rejected by harness policy: networkPolicy disabled.`,
        toolUseID,
      )
    }
    if (networkDisabled && toolName === 'Agent') {
      return deny(
        'AgentTool rejected by harness policy: networkPolicy disabled.',
        toolUseID,
      )
    }

    if (toolName === 'Bash') {
      const command = String(toolInput.command ?? '')
      const timeoutReason = denyIfBashTimeoutTooLong(toolInput)
      if (timeoutReason) return deny(timeoutReason, toolUseID)
      const unboundedBackgroundReason = denyIfBashUnboundedBackground(command)
      if (unboundedBackgroundReason) return deny(unboundedBackgroundReason, toolUseID)
      const reason = denyIfBashUnsafe(command, taskRun)
      if (reason) return deny(reason, toolUseID)
      const pathAccessReason = denyIfBashPathAccessDisallowed(command, taskRun, allowedReadRoots)
      if (pathAccessReason) return deny(pathAccessReason, toolUseID)
      return allow(toolInput)
    }

    for (const candidate of pathValues(toolInput)) {
      const forbidden = isForbiddenPath(candidate)
      if (forbidden && !isAllowedKnownTaskForbiddenPath(candidate, forbidden, taskRun)) {
        return deny(
          `Tool input references forbidden path segment "${forbidden}".`,
          toolUseID,
        )
      }
      const absolute = resolveHarnessPath(taskRun.runDir, candidate, taskRun)
      if (!absolute) {
        return deny(`${toolName} path could not be resolved safely: ${candidate}.`, toolUseID)
      }
      if (WRITE_TOOLS.has(toolName)) {
        if (!isAllowedWrite(absolute, taskRun)) {
          return deny(
            `${toolName} may only write under workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`,
            toolUseID,
          )
        }
      } else if (READ_PATH_TOOLS.has(toolName) && !isAllowedRead(absolute, taskRun, allowedReadRoots)) {
        return deny(
          `${toolName} may only read public/, workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`,
          toolUseID,
        )
      }
    }

    return allow(toolInput)
  }
}
