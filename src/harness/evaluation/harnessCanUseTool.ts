import { relative, resolve } from 'path'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { TaskRun } from './types.js'

export type HarnessCanUseToolInput = {
  taskRun: TaskRun
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
const BASH_CONTROL_OPERATORS = new Set(['&&', '||', '|', ';'])
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

function normalizeForCompare(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(path: string, parent: string): boolean {
  const child = normalizeForCompare(path)
  const base = normalizeForCompare(parent)
  return child === base || child.startsWith(`${base}\\`) || child.startsWith(`${base}/`)
}

function isForbiddenPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return FORBIDDEN_PATH_PARTS.find(part => normalized.split('/').includes(part))
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
    if (normalized.includes(part.toLowerCase())) {
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

function isAllowedRead(path: string, taskRun: TaskRun): boolean {
  return (
    isInside(path, taskRun.publicDir) ||
    isInside(path, taskRun.workspaceDir) ||
    isInside(path, taskRun.outputsDir) ||
    isInside(path, resolve(taskRun.logsDir, 'agent'))
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
  const rel = relative(taskRun.runDir, resolve(path)).replace(/\\/g, '/')
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
    if (char === '|' && next === '|') {
      flush()
      tokens.push('||')
      i++
      continue
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

function hasDynamicPathSyntax(path: string): boolean {
  return /[$`*?[\]{}~]/.test(path)
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

function writeTargetsForCommand(name: string, args: string[]): string[] {
  const operands = nonFlagArgs(args)
  if (name === 'cp' || name === 'mv' || name === 'ln') {
    return operands.length > 0 ? [operands[operands.length - 1]!] : []
  }
  return operands
}

function resolveShellPath(cwd: string, candidate: string): string | undefined {
  if (!candidate || hasDynamicPathSyntax(candidate)) return undefined
  return resolve(cwd, candidate)
}

function denyIfPublicPathWritten(
  candidate: string,
  cwd: string,
  taskRun: TaskRun,
): string | undefined {
  const absolute = resolveShellPath(cwd, candidate)
  if (!absolute) {
    if (isInside(cwd, taskRun.publicDir)) {
      return `Bash command rejected: dynamic write path "${candidate}" would execute from public/.`
    }
    return undefined
  }
  if (isInside(absolute, taskRun.publicDir)) {
    return `Bash command rejected: write target resolves under public/: ${relativeToRun(absolute, taskRun)}.`
  }
  return undefined
}

function denyIfBashWritesPublic(command: string, taskRun: TaskRun): string | undefined {
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
      currentCwd = target
        ? resolveShellPath(currentCwd, target) ?? taskRun.publicDir
        : taskRun.runDir
      return undefined
    }

    if (!BASH_WRITE_COMMANDS.has(name)) return undefined
    for (const target of writeTargetsForCommand(name, args)) {
      const reason = denyIfPublicPathWritten(target, currentCwd, taskRun)
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
        const reason = denyIfPublicPathWritten(target, currentCwd, taskRun)
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

  return async (tool, rawInput, _toolUseContext, _assistantMessage, toolUseID) => {
    const toolInput = asRecord(rawInput)
    const toolName = tool.name

    if (toolName === 'Bash') {
      const command = String(toolInput.command ?? '')
      const reason = denyIfBashUnsafe(command, taskRun)
      if (reason) return deny(reason, toolUseID)
      const publicWriteReason = denyIfBashWritesPublic(command, taskRun)
      if (publicWriteReason) return deny(publicWriteReason, toolUseID)
      return allow(toolInput)
    }

    for (const candidate of pathValues(toolInput)) {
      const forbidden = isForbiddenPath(candidate)
      if (forbidden) {
        return deny(
          `Tool input references forbidden path segment "${forbidden}".`,
          toolUseID,
        )
      }
      const absolute = resolve(taskRun.runDir, candidate)
      if (WRITE_TOOLS.has(toolName)) {
        if (!isAllowedWrite(absolute, taskRun)) {
          return deny(
            `${toolName} may only write under workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`,
            toolUseID,
          )
        }
      } else if (READ_PATH_TOOLS.has(toolName) && !isAllowedRead(absolute, taskRun)) {
        return deny(
          `${toolName} may only read public/, workspace/, outputs/, or logs/agent; got ${relativeToRun(absolute, taskRun)}.`,
          toolUseID,
        )
      }
    }

    return allow(toolInput)
  }
}
