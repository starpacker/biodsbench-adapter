import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { JudgeResult } from './types.js'

export type ResumeRunSnapshot = {
  runDir: string
  taskId: string
  runManifest: unknown
  latestPlan?: string
  runMemory?: string
  latestJudgeResult?: JudgeResult
  contextEvents: Array<{ round?: number; subtype: string; message?: string }>
}

export type LoadResumeRunSnapshotOptions = {
  runsRoot?: string
  expectedTaskId?: string
}

const FORBIDDEN_RESUME_MARKERS = [
  '.judge_private',
  'ground_truth',
  'answer.npz',
  'reference_outputs',
  'std_code',
]

function markerPattern(marker: string): RegExp {
  return new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function sanitizeResumeText(value: string | undefined, maxChars = 6000): string | undefined {
  if (value === undefined) return undefined
  let sanitized = value
  for (const marker of FORBIDDEN_RESUME_MARKERS) {
    sanitized = sanitized.replace(markerPattern(marker), '[redacted]')
  }
  return sanitized.length <= maxChars
    ? sanitized
    : `${sanitized.slice(0, maxChars)}\n... [resume content truncated] ...\n`
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const text = await readTextIfExists(path)
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function readCleanTrajectory(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readTextIfExists(path)
  if (!text) return []
  return text
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => asRecord(JSON.parse(line)))
}

function judgeResultFromClean(record: Record<string, unknown>): JudgeResult | undefined {
  if (record.kind !== 'judge_result') return undefined
  const status = record.status
  if (status !== 'pass' && status !== 'fail' && status !== 'error') return undefined
  return {
    status,
    reward: typeof record.reward === 'number' ? record.reward : 0,
    feedback: typeof record.feedback === 'string'
      ? record.feedback
      : JSON.stringify(record.feedback ?? {}),
    raw: record.feedback ?? {},
  }
}

function rejectUnsafeRunDir(resolvedRunDir: string): void {
  const normalized = resolvedRunDir.replace(/\\/g, '/')
  if (normalized.includes('/.judge_private/') || normalized.endsWith('/.judge_private')) {
    throw new Error('Cannot resume from private judge paths.')
  }
}

function assertInsideRunsRoot(resolvedRunDir: string, runsRoot: string | undefined): void {
  if (!runsRoot) return
  const resolvedRoot = resolve(runsRoot)
  const rootWithSeparator = resolvedRoot.endsWith('\\') || resolvedRoot.endsWith('/')
    ? resolvedRoot
    : `${resolvedRoot}${resolvedRoot.includes('\\') ? '\\' : '/'}`
  if (resolvedRunDir !== resolvedRoot && !resolvedRunDir.startsWith(rootWithSeparator)) {
    throw new Error(`Resume run is outside run root: ${resolvedRunDir}`)
  }
}

export async function loadResumeRunSnapshot(
  runDir: string,
  options: LoadResumeRunSnapshotOptions = {},
): Promise<ResumeRunSnapshot> {
  const resolvedRunDir = resolve(runDir)
  rejectUnsafeRunDir(resolvedRunDir)
  assertInsideRunsRoot(resolvedRunDir, options.runsRoot)
  const runManifest = await readJsonIfExists(`${resolvedRunDir}/run_manifest.json`)
  const manifest = asRecord(runManifest)
  const taskId = typeof manifest.task_id === 'string' ? manifest.task_id : ''
  if (!taskId) {
    throw new Error(`Resume run manifest missing task_id: ${resolvedRunDir}`)
  }
  if (options.expectedTaskId && taskId !== options.expectedTaskId) {
    throw new Error(`Resume run task_id ${taskId} does not match current task ${options.expectedTaskId}`)
  }
  const records = await readCleanTrajectory(`${resolvedRunDir}/logs/trajectory.clean.jsonl`)
  const latestJudgeResult = records
    .map(judgeResultFromClean)
    .filter((item): item is JudgeResult => Boolean(item))
    .at(-1)
  const contextEvents = records
    .filter(record => record.kind === 'context_event')
    .map(record => ({
      round: typeof record.round === 'number' ? record.round : undefined,
      subtype: typeof record.subtype === 'string' ? record.subtype : 'context_event',
      message: typeof record.message === 'string' ? sanitizeResumeText(record.message, 300) : undefined,
    }))

  return {
    runDir: resolvedRunDir,
    taskId,
    runManifest,
    latestPlan: sanitizeResumeText(await readTextIfExists(`${resolvedRunDir}/workspace/plan.md`)),
    runMemory: sanitizeResumeText(await readTextIfExists(`${resolvedRunDir}/workspace/agent_memory.md`)),
    latestJudgeResult,
    contextEvents,
  }
}
