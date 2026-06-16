import { appendFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  EvaluationRunMetadata,
  JudgeResult,
  LoopStatus,
  SourceAgentEvent,
  SubmissionValidationIssue,
  TaskRun,
} from './types.js'

export type CleanTrajectoryRecord =
  | {
      kind: 'run_context'
      task_id: string
      run_id: string
      started_at: string
      runtime_python?: string
      run_metadata?: EvaluationRunMetadata
    }
  | {
      kind: 'assistant_text'
      round: number
      text: string
    }
  | {
      kind: 'tool_call'
      round: number
      tool: string
      tool_use_id?: string
      input?: unknown
    }
  | {
      kind: 'tool_result'
      round: number
      tool_use_id?: string
      ok: boolean
      text?: string
    }
  | {
      kind: 'policy_deny'
      round: number
      tool: string
      reason: string
    }
  | {
      kind: 'trajectory_warning'
      round: number
      code: string
      message: string
      details?: unknown
    }
  | {
      kind: 'recovery_started'
      round: number
      message: string
    }
  | {
      kind: 'recovery_finished'
      round: number
      finalized: boolean
      summary?: string
    }
  | {
      kind: 'submission_validation_failed'
      round: number
      ok: false
      normalized_files: string[]
      issues: SubmissionValidationIssue[]
    }
  | {
      kind: 'submission_validation_passed'
      round: number
      ok: true
      normalized_files: string[]
      issues: SubmissionValidationIssue[]
    }
  | {
      kind: 'agent_result'
      round: number
      subtype?: string
      stop_reason?: string | null
      duration_ms?: number
      duration_api_ms?: number
      is_error?: boolean
      usage?: unknown
      errors?: string[]
    }
  | {
      kind: 'finalize'
      round: number
      summary: string
      files: string[]
    }
  | {
      kind: 'judge_result'
      round: number
      status: JudgeResult['status']
      reward: number
      feedback: unknown
    }
  | {
      kind: 'run_finished'
      status: LoopStatus
      reward: number
      completed_at: string
      final_result?: unknown
    }

function truncateText(value: string | undefined, maxLength = 4000): string | undefined {
  if (!value || value.length <= maxLength) return value
  const keep = Math.floor(maxLength / 2)
  return `${value.slice(0, keep)}\n... [${value.length - maxLength} chars truncated] ...\n${value.slice(-keep)}`
}

function isShortAsciiPunctuationOnly(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 3) return false
  return [...trimmed].every(char => {
    const code = char.charCodeAt(0)
    return (
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    )
  })
}

export function cleanAssistantTextForTrajectory(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (isShortAsciiPunctuationOnly(trimmed)) return undefined

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  let removedLeadingNoise = false
  while (index < lines.length && isShortAsciiPunctuationOnly(lines[index] ?? '')) {
    removedLeadingNoise = true
    index++
    while (index < lines.length && (lines[index] ?? '').trim() === '') index++
  }

  if (!removedLeadingNoise) return text
  const cleaned = lines.slice(index).join('\n').trim()
  return cleaned ? cleaned : undefined
}

function cleanInput(input: unknown): unknown {
  if (typeof input === 'string') return truncateText(input, 2000)
  if (!input || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(cleanInput)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' ? truncateText(value, 2000) : cleanInput(value)
  }
  return out
}

export class SourceTrajectoryWriter {
  readonly cleanPath: string
  readonly rawPath: string
  private readonly taskRun: TaskRun

  constructor(taskRun: TaskRun) {
    this.taskRun = taskRun
    this.cleanPath = join(taskRun.logsDir, 'trajectory.clean.jsonl')
    this.rawPath = join(taskRun.logsDir, 'trajectory.raw.jsonl')
  }

  async start(input: {
    startedAt: string
    runtimePython?: string
    runMetadata?: EvaluationRunMetadata
  }): Promise<void> {
    await mkdir(this.taskRun.logsDir, { recursive: true })
    await writeFile(this.cleanPath, '', 'utf8')
    await writeFile(this.rawPath, '', 'utf8')
    await this.appendClean({
      kind: 'run_context',
      task_id: this.taskRun.taskId,
      run_id: this.taskRun.runId,
      started_at: input.startedAt,
      runtime_python: input.runtimePython,
      run_metadata: input.runMetadata,
    })
  }

  async appendClean(record: CleanTrajectoryRecord): Promise<void> {
    await appendFile(this.cleanPath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  async appendRaw(record: unknown): Promise<void> {
    await appendFile(this.rawPath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  async agentEvent(round: number, event: SourceAgentEvent): Promise<void> {
    await this.appendRaw({ round, ...event })
    if (event.type === 'assistant_text') {
      const text = cleanAssistantTextForTrajectory(event.text)
      if (text !== undefined) {
        await this.appendClean({
          kind: 'assistant_text',
          round,
          text: truncateText(text) ?? '',
        })
      }
      return
    }
    if (event.type === 'tool_call') {
      await this.appendClean({
        kind: 'tool_call',
        round,
        tool: event.tool,
        tool_use_id: event.toolUseId,
        input: cleanInput(event.input),
      })
      return
    }
    if (event.type === 'tool_result') {
      await this.appendClean({
        kind: 'tool_result',
        round,
        tool_use_id: event.toolUseId,
        ok: event.ok,
        text: truncateText(event.text),
      })
      return
    }
    if (event.type === 'policy_deny') {
      await this.appendClean({
        kind: 'policy_deny',
        round,
        tool: event.tool,
        reason: event.reason,
      })
      return
    }
    if (event.type === 'trajectory_warning') {
      await this.appendClean({
        kind: 'trajectory_warning',
        round,
        code: event.code,
        message: event.message,
        details: cleanInput(event.details),
      })
      return
    }
    if (event.type === 'run_warning') {
      await this.appendClean({
        kind: 'trajectory_warning',
        round,
        code: event.code,
        message: event.message,
        details: cleanInput(event.details),
      })
      return
    }
    if (event.type === 'submission_validation_failed') {
      await this.appendClean({
        kind: 'submission_validation_failed',
        round,
        ok: false,
        normalized_files: event.result.normalizedFiles,
        issues: event.result.issues,
      })
      return
    }
    if (event.type === 'submission_validation_passed') {
      await this.appendClean({
        kind: 'submission_validation_passed',
        round,
        ok: true,
        normalized_files: event.result.normalizedFiles,
        issues: event.result.issues,
      })
      return
    }
    if (event.type === 'agent_result') {
      await this.appendClean({
        kind: 'agent_result',
        round,
        subtype: event.subtype,
        stop_reason: event.stopReason,
        duration_ms: event.durationMs,
        duration_api_ms: event.durationApiMs,
        is_error: event.isError,
        usage: event.usage,
        errors: event.errors,
      })
      return
    }
    await this.appendClean({
      kind: 'finalize',
      round,
      summary: event.summary,
      files: event.files,
    })
  }
}
