import { isAbsolute, relative, resolve } from 'path'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../types/permissions.js'

export type OracleSkillAuthorCanUseToolInput = {
  taskDir: string
  authorWorkspaceDir: string
}

const READ_PATH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const FORBIDDEN_PATH_PARTS = [
  '.judge_private',
  'evaluation',
  'ground_truth',
  'reference_outputs',
  'private_judge',
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
  /\brm\b/i,
  /\bdel\b/i,
  /\bRemove-Item\b/i,
  /\bmv\b/i,
  /\bmove\b/i,
]
const PATH_SCANNING_BASH = /^(rg|grep|cat|head|tail|ls|dir|find|Get-Content|Select-String|Get-ChildItem)\b/i

function normalizeForCompare(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizeText(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function isInside(path: string, parent: string): boolean {
  const child = normalizeForCompare(path)
  const base = normalizeForCompare(parent)
  return child === base || child.startsWith(`${base}${process.platform === 'win32' ? '\\' : '/'}`)
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
    decisionReason: { type: 'other', reason: 'oracle skill author policy allow' },
  }
}

function hasForbiddenPathPart(candidate: string): string | undefined {
  const parts = normalizeText(candidate).split('/')
  return FORBIDDEN_PATH_PARTS.find(part => parts.includes(part))
}

function resolvePath(cwd: string, candidate: string): string | undefined {
  if (!candidate || candidate.includes('$') || candidate.includes('*')) return undefined
  return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
}

function isAllowedRead(path: string, taskDir: string, authorWorkspaceDir: string): boolean {
  const publicFiles = [
    resolve(taskDir, 'README.md'),
    resolve(taskDir, 'output_schema.json'),
  ]
  return (
    publicFiles.some(file => normalizeForCompare(file) === normalizeForCompare(path)) ||
    isInside(path, resolve(taskDir, 'visible_data')) ||
    isInside(path, resolve(taskDir, 'std_code')) ||
    isInside(path, authorWorkspaceDir)
  )
}

function commandMentionsAllowedRoot(command: string, roots: string[]): boolean {
  const normalizedCommand = normalizeText(command)
  const cwd = process.cwd()
  return roots.some(root => {
    const absolute = normalizeText(resolve(root))
    const relativeRoot = normalizeText(relative(cwd, resolve(root)))
    return (
      normalizedCommand.includes(absolute) ||
      (relativeRoot && normalizedCommand.includes(relativeRoot))
    )
  })
}

function denyIfBashUnsafe(
  command: string,
  taskDir: string,
  authorWorkspaceDir: string,
): string | undefined {
  if (!command.trim()) return 'Bash command is empty.'
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) return `Bash command rejected by oracle author policy: ${pattern.source}`
  }
  const forbidden = FORBIDDEN_PATH_PARTS.find(part => normalizeText(command).includes(part))
  if (forbidden) return `Bash command rejected: command references forbidden path segment "${forbidden}".`
  if (
    PATH_SCANNING_BASH.test(command.trim()) &&
    !commandMentionsAllowedRoot(command, [
      resolve(taskDir, 'visible_data'),
      resolve(taskDir, 'std_code'),
      authorWorkspaceDir,
    ])
  ) {
    return 'Bash read commands must target the current task visible_data/, current task standard source, or author workspace.'
  }
  return undefined
}

export function createOracleSkillAuthorCanUseTool(
  input: OracleSkillAuthorCanUseToolInput,
): CanUseToolFn {
  const taskDir = resolve(input.taskDir)
  const authorWorkspaceDir = resolve(input.authorWorkspaceDir)

  return async (tool, rawInput, _toolUseContext, _assistantMessage, toolUseID) => {
    const toolInput = asRecord(rawInput)
    const toolName = tool.name

    if (toolName === 'Bash') {
      const command = String(toolInput.command ?? '')
      const reason = denyIfBashUnsafe(command, taskDir, authorWorkspaceDir)
      return reason ? deny(reason, toolUseID) : allow(toolInput)
    }

    if (toolName === 'StructuredOutput' || toolName === 'TodoWrite') {
      return allow(toolInput)
    }

    const paths = pathValues(toolInput)
    if ((toolName === 'Glob' || toolName === 'Grep') && paths.length === 0) {
      return deny(`${toolName} must set a path under the current task or author workspace.`, toolUseID)
    }

    for (const candidate of paths) {
      const forbidden = hasForbiddenPathPart(candidate)
      if (forbidden) {
        return deny(`Tool input references forbidden path segment "${forbidden}".`, toolUseID)
      }
      const absolute = resolvePath(process.cwd(), candidate)
      if (!absolute) return deny(`${toolName} path could not be resolved safely: ${candidate}.`, toolUseID)
      if (WRITE_TOOLS.has(toolName)) {
        if (!isInside(absolute, authorWorkspaceDir)) {
          return deny(`${toolName} may only write under the oracle author workspace.`, toolUseID)
        }
      } else if (READ_PATH_TOOLS.has(toolName)) {
        if (!isAllowedRead(absolute, taskDir, authorWorkspaceDir)) {
          return deny(`${toolName} may only read the current task public authoring files, current task standard source, or author workspace.`, toolUseID)
        }
      }
    }

    return allow(toolInput)
  }
}
