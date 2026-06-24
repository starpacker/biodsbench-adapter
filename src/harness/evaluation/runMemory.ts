import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { compactJudgeFeedback } from './sourceContextBuilder.js'
import type { JudgeResult, TaskRun } from './types.js'

const FORBIDDEN_MARKERS = [
  '.judge_private',
  'ground_truth',
  'answer.npz',
  'reference_outputs',
  'std_code',
]

function markerPattern(marker: string): RegExp {
  return new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}

export type RunMemoryInput = {
  taskRun: TaskRun
  trajectoryPath: string
  latestJudgeResult?: JudgeResult
  maxChars?: number
}

export type RunMemorySnapshot = {
  path: string
  content: string
  observations: string[]
  failedMetrics: string[]
  attemptedFiles: string[]
  nextConstraints: string[]
}

function sanitizeText(value: string, maxChars = 1000): string {
  let sanitized = value
  for (const marker of FORBIDDEN_MARKERS) {
    sanitized = sanitized.replace(markerPattern(marker), '[redacted]')
  }
  return sanitized.length <= maxChars
    ? sanitized
    : `${sanitized.slice(0, maxChars)}... [truncated]`
}

function containsForbidden(value: unknown): boolean {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? '')).toLowerCase()
  return FORBIDDEN_MARKERS.some(marker => text.includes(marker))
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function readCleanRecords(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, 'utf8')
    return text
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => asRecord(JSON.parse(line)))
  } catch {
    return []
  }
}

function collectAttemptedFiles(records: Array<Record<string, unknown>>): string[] {
  const files: string[] = []
  for (const record of records) {
    if (record.kind !== 'tool_call') continue
    if (containsForbidden(record)) continue
    const input = asRecord(record.input)
    for (const key of ['file_path', 'path']) {
      const value = input[key]
      if (typeof value === 'string') files.push(sanitizeText(value, 300))
    }
    const command = input.command
    if (typeof command === 'string') {
      for (const match of command.matchAll(/\b(?:workspace|outputs|public)\/[A-Za-z0-9_.@/-]+/g)) {
        files.push(sanitizeText(match[0], 300))
      }
    }
  }
  return unique(files).slice(0, 20)
}

function collectObservations(records: Array<Record<string, unknown>>): string[] {
  const observations: string[] = []
  for (const record of records) {
    if (record.kind === 'context_event') {
      const subtype = typeof record.subtype === 'string' ? record.subtype : 'context_event'
      const message = typeof record.message === 'string' ? `: ${sanitizeText(record.message, 300)}` : ''
      observations.push(`${subtype}${message}`)
    }
    if (record.kind === 'trajectory_warning') {
      const code = typeof record.code === 'string' ? record.code : 'trajectory_warning'
      const message = typeof record.message === 'string' ? `: ${sanitizeText(record.message, 300)}` : ''
      observations.push(`${code}${message}`)
    }
  }
  return unique(observations).slice(-10)
}

function failedMetricsFromJudge(judgeResult: JudgeResult | undefined): string[] {
  if (!judgeResult) return []
  return compactJudgeFeedback(judgeResult).failedMetrics.map(item =>
    sanitizeText(item, 200),
  )
}

function buildRunMemoryMarkdown(input: {
  taskRun: TaskRun
  observations: string[]
  failedMetrics: string[]
  attemptedFiles: string[]
  latestJudgeResult?: JudgeResult
  nextConstraints: string[]
  maxChars: number
}): string {
  const lines = [
    '# Run Memory',
    '',
    `task_id: ${sanitizeText(input.taskRun.taskId, 200)}`,
    `run_id: ${sanitizeText(input.taskRun.runId, 200)}`,
    '',
    '## Recent Judge Feedback',
    input.latestJudgeResult
      ? `- status=${input.latestJudgeResult.status}, reward=${input.latestJudgeResult.reward}, message=${sanitizeText(input.latestJudgeResult.feedback, 600)}`
      : '- No judge feedback recorded yet.',
    '',
    '## Failed Metrics',
    ...(input.failedMetrics.length > 0
      ? input.failedMetrics.map(item => `- ${item}`)
      : ['- (none recorded)']),
    '',
    '## Attempted Files And Commands',
    ...(input.attemptedFiles.length > 0
      ? input.attemptedFiles.map(item => `- ${item}`)
      : ['- (none recorded)']),
    '',
    '## Context Observations',
    ...(input.observations.length > 0
      ? input.observations.map(item => `- ${item}`)
      : ['- (none recorded)']),
    '',
    '## Next-Round Constraints',
    ...input.nextConstraints.map(item => `- ${item}`),
    '',
  ]
  const content = lines.join('\n')
  return content.length <= input.maxChars
    ? content
    : `${content.slice(0, input.maxChars)}\n... [run memory truncated] ...\n`
}

export async function writeRunMemory(
  input: RunMemoryInput,
): Promise<RunMemorySnapshot> {
  const records = await readCleanRecords(input.trajectoryPath)
  const attemptedFiles = collectAttemptedFiles(records)
  const observations = collectObservations(records)
  const failedMetrics = failedMetricsFromJudge(input.latestJudgeResult)
  const nextConstraints = [
    'Use only public/, workspace/, outputs/, and logs/agent/ paths.',
    'Start the next judge round by writing a round plan before implementation.',
    'If active skills are enabled, call Skill before modifying solver code.',
    'If active skills are enabled, re-read Skill and identify which skill contract item failed, was ignored, or was disproved.',
    'Do not repeat long optimization or simulation runs until a cheap probe and observable runtime evidence justify them.',
    'Do not use hidden judge data, known-task private files, or source task materials.',
  ]
  const path = join(input.taskRun.workspaceDir, 'agent_memory.md')
  const content = buildRunMemoryMarkdown({
    taskRun: input.taskRun,
    observations,
    failedMetrics,
    attemptedFiles,
    latestJudgeResult: input.latestJudgeResult,
    nextConstraints,
    maxChars: input.maxChars ?? 8000,
  })
  await mkdir(input.taskRun.workspaceDir, { recursive: true })
  await writeFile(path, content, 'utf8')
  return {
    path,
    content,
    observations,
    failedMetrics,
    attemptedFiles,
    nextConstraints,
  }
}
