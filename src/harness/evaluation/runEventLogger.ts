import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { SourceAgentEvent, TaskRun } from './types.js'

export type RunEventType =
  | 'run_started'
  | 'agent_step_started'
  | 'agent_step_finished'
  | 'agent_step_error'
  | 'agent_recovery_started'
  | 'agent_recovery_finished'
  | 'agent_event'
  | 'submission_validation_failed'
  | 'submission_validation_passed'
  | 'run_warning'
  | 'judge_started'
  | 'judge_finished'
  | 'run_finished'

export type RunEvent = {
  timestamp: string
  run_id: string
  task_id: string
  type: RunEventType
  judge_round?: number
  agent_step?: number
  message?: string
  details?: unknown
}

export type RunEventLoggerInput = {
  taskRun: TaskRun
  verbose?: boolean
}

function shorten(value: string, maxLength = 240): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`
}

export function summarizeAgentEvent(event: SourceAgentEvent): Record<string, unknown> {
  if (event.type === 'assistant_text') {
    return { type: event.type, text_length: event.text.length }
  }
  if (event.type === 'tool_call') {
    return { type: event.type, tool: event.tool, toolUseId: event.toolUseId }
  }
  if (event.type === 'tool_result') {
    return {
      type: event.type,
      ok: event.ok,
      toolUseId: event.toolUseId,
      text_tail: event.text?.slice(-1000),
    }
  }
  if (event.type === 'policy_deny') {
    return { type: event.type, tool: event.tool, reason: event.reason }
  }
  if (event.type === 'trajectory_warning') {
    return {
      type: event.type,
      code: event.code,
      message: event.message,
      details: event.details,
    }
  }
  if (event.type === 'run_warning') {
    return {
      type: event.type,
      code: event.code,
      message: event.message,
      details: event.details,
    }
  }
  if (event.type === 'submission_validation_failed') {
    return {
      type: event.type,
      ok: event.result.ok,
      issue_count: event.result.issues.length,
      normalized_files: event.result.normalizedFiles,
      issues: event.result.issues,
    }
  }
  if (event.type === 'submission_validation_passed') {
    return {
      type: event.type,
      ok: event.result.ok,
      normalized_files: event.result.normalizedFiles,
    }
  }
  if (event.type === 'agent_result') {
    return {
      type: event.type,
      subtype: event.subtype,
      stopReason: event.stopReason,
      isError: event.isError,
      durationMs: event.durationMs,
      errors: event.errors,
    }
  }
  return { type: event.type, summary: event.summary, files: event.files }
}

function formatConsoleEvent(event: RunEvent): string {
  const prefix = `[${event.timestamp}] ${event.type}`
  const round = event.judge_round ? ` round=${event.judge_round}` : ''
  const step = event.agent_step ? ` step=${event.agent_step}` : ''
  const message = event.message ? ` ${shorten(event.message)}` : ''
  return `${prefix}${round}${step}${message}`
}

export class RunEventLogger {
  readonly path: string
  private readonly taskRun: TaskRun
  private readonly verbose: boolean

  constructor(input: RunEventLoggerInput) {
    this.taskRun = input.taskRun
    this.verbose = Boolean(input.verbose)
    this.path = join(input.taskRun.logsDir, 'run_events.jsonl')
  }

  async log(
    type: RunEventType,
    event: Omit<Partial<RunEvent>, 'timestamp' | 'run_id' | 'task_id' | 'type'> = {},
  ): Promise<void> {
    const record: RunEvent = {
      timestamp: new Date().toISOString(),
      run_id: this.taskRun.runId,
      task_id: this.taskRun.taskId,
      type,
      ...event,
    }
    await mkdir(this.taskRun.logsDir, { recursive: true })
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    if (this.verbose) {
      process.stderr.write(`${formatConsoleEvent(record)}\n`)
    }
  }
}
