import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createTaskRun } from './taskEnvironment.js'
import { DefaultJudgeRunner } from './judgeRunner.js'
import { collectRunMetadata } from './runMetadata.js'
import { RunEventLogger, summarizeAgentEvent } from './runEventLogger.js'
import {
  buildInitialSourcePrompt,
  buildJudgeFeedbackPrompt,
  buildNoFinalizeRecoveryPrompt,
  compactJudgeFeedback,
} from './sourceContextBuilder.js'
import { resolveTaskRuntime } from './sourceRuntimeResolver.js'
import { SourceTrajectoryWriter } from './sourceTrajectoryWriter.js'
import type {
  EvaluationRunMetadata,
  JudgeResult,
  LoopStatus,
  RunSourceTaskLoopInput,
  RunSourceTaskLoopResult,
  SourceAgentEvent,
  SourceAgentStartInput,
  SourceAgentSession,
  SourceAgentTurnInput,
  SourceRunWarning,
  SubmissionValidationResult,
} from './types.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

const AGENT_GENERATOR_CLOSE_GRACE_MS = 5000
const SESSION_DISPOSE_GRACE_MS = 5000

function isTimeoutError(error: unknown): boolean {
  return errorMessage(error).includes('timed out')
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`${label} timed out`)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function closeAgentEvents(
  events: AsyncGenerator<SourceAgentEvent, void, unknown>,
  graceMs = AGENT_GENERATOR_CLOSE_GRACE_MS,
): Promise<void> {
  if (!events.return) return
  try {
    await withTimeout(events.return(), graceMs, 'Agent event generator close')
  } catch {
    // Best-effort close. Preserve the original timeout/error path.
  }
}

async function disposeSessionWithTimeout(
  session: SourceAgentSession,
  eventLogger: RunEventLogger,
  graceMs = SESSION_DISPOSE_GRACE_MS,
): Promise<void> {
  if (!session.dispose) return
  try {
    await withTimeout(session.dispose(), graceMs, 'Session dispose')
  } catch (error) {
    await eventLogger.log('run_warning', {
      message: `Session dispose did not finish cleanly: ${errorMessage(error)}`,
      details: { code: 'session_dispose_timeout' },
    })
  }
}

async function loadUserTask(publicDir: string): Promise<string> {
  try {
    return await readFile(join(publicDir, 'README.md'), 'utf8')
  } catch {
    return ''
  }
}

async function writeRunSummary(input: {
  path: string
  status: LoopStatus
  rounds: number
  reward: number
  finalResult: unknown
  trajectoryPath: string
  runMetadata: EvaluationRunMetadata
  validationAttempts: SubmissionValidationResult[]
  warnings: SourceRunWarning[]
}): Promise<void> {
  await mkdir(resolve(input.path, '..'), { recursive: true })
  await writeFile(
    input.path,
    `${JSON.stringify(
      {
        status: input.status,
        rounds: input.rounds,
        reward: input.reward,
        final_result: input.finalResult,
        trajectory_path: input.trajectoryPath,
        run_metadata: input.runMetadata,
        validation_attempts: input.validationAttempts.map(result => ({
          ok: result.ok,
          normalized_files: result.normalizedFiles,
          issues: result.issues,
        })),
        warnings: input.warnings,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

type LoopEventAggregation = {
  validationAttempts: SubmissionValidationResult[]
  warnings: SourceRunWarning[]
}

function recordAgentEventForSummary(
  event: SourceAgentEvent,
  aggregation: LoopEventAggregation,
): void {
  if (
    event.type === 'submission_validation_failed' ||
    event.type === 'submission_validation_passed'
  ) {
    aggregation.validationAttempts.push(event.result)
    return
  }
  if (event.type === 'run_warning' || event.type === 'trajectory_warning') {
    aggregation.warnings.push({
      code: event.code,
      message: event.message,
      details: event.details,
    })
  }
}

function eventLogTypeForAgentEvent(event: SourceAgentEvent) {
  if (event.type === 'submission_validation_failed') {
    return {
      type: 'submission_validation_failed' as const,
      message: `finalize_submission validation failed (${event.result.issues.length} issues)`,
    }
  }
  if (event.type === 'submission_validation_passed') {
    return {
      type: 'submission_validation_passed' as const,
      message: `finalize_submission validation passed (${event.result.normalizedFiles.length} files)`,
    }
  }
  if (event.type === 'run_warning' || event.type === 'trajectory_warning') {
    return {
      type: 'run_warning' as const,
      message: event.message,
    }
  }
  return {
    type: 'agent_event' as const,
    message: event.type,
  }
}

async function drainAgentTurn(input: {
  events: AsyncGenerator<SourceAgentEvent, void, unknown>
  deadline: number
  round: number
  trajectory: SourceTrajectoryWriter
  eventLogger: RunEventLogger
  aggregation: LoopEventAggregation
  onTimeout?: () => void
}): Promise<{ finalized?: Extract<SourceAgentEvent, { type: 'finalize' }> }> {
  let finalized: Extract<SourceAgentEvent, { type: 'finalize' }> | undefined
  for (;;) {
    let next: IteratorResult<SourceAgentEvent, void>
    try {
      next = await withTimeout(
        input.events.next(),
        remainingMilliseconds(input.deadline),
        'Agent inference',
      )
    } catch (error) {
      if (isTimeoutError(error)) {
        input.onTimeout?.()
      }
      await closeAgentEvents(input.events)
      throw error
    }
    if (next.done) break
    await input.trajectory.agentEvent(input.round, next.value)
    recordAgentEventForSummary(next.value, input.aggregation)
    const logEvent = eventLogTypeForAgentEvent(next.value)
    await input.eventLogger.log(logEvent.type, {
      judge_round: input.round,
      message: logEvent.message,
      details: summarizeAgentEvent(next.value),
    })
    if (next.value.type === 'finalize') {
      finalized = next.value
      await closeAgentEvents(input.events)
      break
    }
  }
  return { finalized }
}

async function runAgentStepWithRecovery(input: {
  session: SourceAgentSession
  taskRun: SourceAgentTurnInput['taskRun']
  runtime: SourceAgentTurnInput['runtime']
  round: number
  maxRounds: number
  maxTurnsPerRound?: number
  prompt: string
  deadline: number
  trajectory: SourceTrajectoryWriter
  eventLogger: RunEventLogger
  aggregation: LoopEventAggregation
}): Promise<{
  finalized?: Extract<SourceAgentEvent, { type: 'finalize' }>
  recovered: boolean
}> {
  const submit = (prompt: string) =>
    input.session.submit({
      taskRun: input.taskRun,
      round: input.round,
      maxRounds: input.maxRounds,
      maxTurnsPerRound: input.maxTurnsPerRound,
      prompt,
      runtime: input.runtime,
    })

  const first = await drainAgentTurn({
    events: submit(input.prompt),
    deadline: input.deadline,
    round: input.round,
    trajectory: input.trajectory,
    eventLogger: input.eventLogger,
    aggregation: input.aggregation,
    onTimeout: () => input.session.interrupt?.('timeout'),
  })
  if (first.finalized || Date.now() >= input.deadline) {
    return { finalized: first.finalized, recovered: false }
  }

  await input.eventLogger.log('agent_recovery_started', {
    judge_round: input.round,
    message: 'Agent turn ended without finalize_submission; requesting forced closure',
  })
  await input.trajectory.appendClean({
    kind: 'recovery_started',
    round: input.round,
    message: 'Agent turn ended without finalize_submission; requesting forced closure',
  })
  const recovery = await drainAgentTurn({
    events: submit(
      buildNoFinalizeRecoveryPrompt({
        round: input.round,
        maxRounds: input.maxRounds,
      }),
    ),
    deadline: input.deadline,
    round: input.round,
    trajectory: input.trajectory,
    eventLogger: input.eventLogger,
    aggregation: input.aggregation,
    onTimeout: () => input.session.interrupt?.('timeout'),
  })
  await input.trajectory.appendClean({
    kind: 'recovery_finished',
    round: input.round,
    finalized: Boolean(recovery.finalized),
    summary: recovery.finalized?.summary,
  })
  await input.eventLogger.log('agent_recovery_finished', {
    judge_round: input.round,
    message: recovery.finalized
      ? `recovery_finalize_submission: ${recovery.finalized.summary}`
      : 'Recovery turn ended without finalize_submission',
  })
  return { finalized: recovery.finalized, recovered: true }
}

function makeJudgeError(error: unknown): JudgeResult {
  const message = `Judge failed before producing a usable result: ${errorMessage(error)}`
  return {
    status: 'error',
    reward: 0,
    feedback: message,
    raw: { error: message },
  }
}

async function createDefaultSourceSession(
  input: SourceAgentStartInput,
): Promise<SourceAgentSession> {
  const module = await import('./sourceClaudeSessionAgent.js')
  return module.createSourceClaudeSessionAgent(input)
}

export async function runSourceTaskLoop(
  input: RunSourceTaskLoopInput,
): Promise<RunSourceTaskLoopResult> {
  const startedAt = new Date().toISOString()
  const deadline = Date.now() + input.timeoutSeconds * 1000
  const maxTurnsPerRound = input.maxTurnsPerRound
  const taskRun = await createTaskRun({
    taskId: input.taskId,
    tasksDir: input.tasksDir ? resolve(input.tasksDir) : undefined,
    runsDir: input.runsDir ? resolve(input.runsDir) : undefined,
    timestamp: input.timestamp,
  })
  const eventLogger = new RunEventLogger({
    taskRun,
    verbose: input.verbose,
  })
  const trajectory = new SourceTrajectoryWriter(taskRun)
  const runMetadata = await collectRunMetadata({ llmOptions: input.llmOptions })
  const aggregation: LoopEventAggregation = {
    validationAttempts: [],
    warnings: [],
  }

  await eventLogger.log('run_started', {
    message: `Run started for task ${taskRun.taskId}: ${taskRun.runDir}`,
    details: {
      maxRounds: input.maxRounds,
      timeoutSeconds: input.timeoutSeconds,
      llmOptions: input.llmOptions,
      runMetadata,
      runDir: taskRun.runDir,
    },
  })

  const runtime = await resolveTaskRuntime(taskRun.publicDir)
  if (!runtime.ok) {
    await trajectory.start({ startedAt, runMetadata })
    await trajectory.appendClean({
      kind: 'run_finished',
      status: 'infra_error',
      reward: 0,
      completed_at: new Date().toISOString(),
      final_result: { error: runtime.error, checked: runtime.checked },
    })
    await eventLogger.log('run_finished', {
      message: `Run finished with status infra_error: ${runtime.error}`,
      details: { checked: runtime.checked },
    })
    await writeRunSummary({
      path: join(taskRun.logsDir, 'run_summary.json'),
      status: 'infra_error',
      rounds: 0,
      reward: 0,
      finalResult: { error: runtime.error, checked: runtime.checked },
      trajectoryPath: trajectory.cleanPath,
      runMetadata,
      validationAttempts: aggregation.validationAttempts,
      warnings: aggregation.warnings,
    })
    return {
      status: 'infra_error',
      rounds: 0,
      reward: 0,
      run: taskRun,
      trajectoryPath: trajectory.cleanPath,
      finalResult: { error: runtime.error, checked: runtime.checked },
    }
  }

  await trajectory.start({
    startedAt,
    runtimePython: runtime.displayPath,
    runMetadata,
  })
  const userTask = await loadUserTask(taskRun.publicDir)
  const session = await (input.sessionFactory ?? createDefaultSourceSession)({
    taskRun,
    maxRounds: input.maxRounds,
    maxTurnsPerRound,
    userTask,
    runtime,
    systemPrompt: input.systemPrompt,
    llmOptions: input.llmOptions,
  })
  const judge = input.judge ?? new DefaultJudgeRunner()

  let finalStatus: LoopStatus = 'failed'
  let finalReward = 0
  let finalResult: unknown = { message: 'No judge rounds completed.' }
  let lastJudgeResult: JudgeResult | undefined
  let judgeRoundsCompleted = 0
  let nextPrompt = await buildInitialSourcePrompt({
    taskRun,
    runtime,
    userTask,
    maxRounds: input.maxRounds,
    priorSubtasks: input.priorSubtasks,
  })

  try {
    while (judgeRoundsCompleted < input.maxRounds) {
      if (Date.now() >= deadline) {
        finalStatus = 'timeout'
        finalResult = { message: 'Task loop timed out before next round.' }
        break
      }

      const round = judgeRoundsCompleted + 1
      await eventLogger.log('agent_step_started', {
        judge_round: round,
        message: 'Submitting prompt to source-native QueryEngine session',
      })
      const { finalized } = await runAgentStepWithRecovery({
        session,
        taskRun,
        runtime,
        round,
        maxRounds: input.maxRounds,
        maxTurnsPerRound,
        prompt: nextPrompt,
        deadline,
        trajectory,
        eventLogger,
        aggregation,
      })
      await eventLogger.log('agent_step_finished', {
        judge_round: round,
        message: finalized
          ? `finalize_submission: ${finalized.summary}`
          : 'Agent turn ended without finalize_submission',
      })

      if (!finalized) {
        finalStatus = Date.now() >= deadline ? 'timeout' : 'failed'
        finalResult = {
          message:
            'Agent turn ended without finalize_submission; judge was not run.',
        }
        break
      }

      judgeRoundsCompleted++
      await eventLogger.log('judge_started', {
        judge_round: round,
        message: `Running judge attempt ${judgeRoundsCompleted}/${input.maxRounds}`,
      })
      let judgeResult: JudgeResult
      try {
        judgeResult = await withTimeout(
          judge.run({
            taskRun,
            runtime,
            round,
            timeoutSeconds: Math.ceil(remainingMilliseconds(deadline) / 1000),
          }),
          remainingMilliseconds(deadline),
          'Judge',
        )
      } catch (error) {
        judgeResult = makeJudgeError(error)
      }

      await trajectory.appendRaw({
        kind: 'judge_result_raw',
        round,
        status: judgeResult.status,
        reward: judgeResult.reward,
        feedback: judgeResult.feedback,
        result_path: judgeResult.resultPath,
        raw: judgeResult.raw,
      })
      const compactFeedback = compactJudgeFeedback(judgeResult)
      await trajectory.appendClean({
        kind: 'judge_result',
        round,
        status: judgeResult.status,
        reward: judgeResult.reward,
        feedback: compactFeedback,
      })
      await eventLogger.log('judge_finished', {
        judge_round: round,
        message: `${judgeResult.status}: ${judgeResult.feedback}`,
        details: {
          status: judgeResult.status,
          reward: judgeResult.reward,
          resultPath: judgeResult.resultPath,
        },
      })

      lastJudgeResult = judgeResult
      finalReward = judgeResult.reward
      finalResult = judgeResult.raw
      if (judgeResult.status === 'pass') {
        finalStatus = 'success'
        break
      }
      if (Date.now() >= deadline) {
        finalStatus = 'timeout'
        break
      }
      if (judgeRoundsCompleted === input.maxRounds) {
        finalStatus = 'failed'
        break
      }
      nextPrompt = buildJudgeFeedbackPrompt({
        round,
        maxRounds: input.maxRounds,
        judgeResult,
      })
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      session.interrupt?.('timeout')
    }
    finalStatus = errorMessage(error).includes('timed out') ? 'timeout' : 'failed'
    finalResult = { error: errorMessage(error) }
    await eventLogger.log('agent_step_error', {
      message: errorMessage(error),
    })
  } finally {
    await disposeSessionWithTimeout(
      session,
      eventLogger,
      input.sessionDisposeGraceMs,
    )
  }

  await trajectory.appendClean({
    kind: 'run_finished',
    status: finalStatus,
    reward: finalReward,
    completed_at: new Date().toISOString(),
    final_result: finalResult,
  })
  await eventLogger.log('run_finished', {
    message: `Run finished with status ${finalStatus}`,
    details: {
      status: finalStatus,
      reward: finalReward,
      judgeRoundsCompleted,
      trajectoryPath: trajectory.cleanPath,
    },
  })
  await writeRunSummary({
    path: join(taskRun.logsDir, 'run_summary.json'),
    status: finalStatus,
    rounds: judgeRoundsCompleted,
    reward: finalReward,
    finalResult,
    trajectoryPath: trajectory.cleanPath,
    runMetadata,
    validationAttempts: aggregation.validationAttempts,
    warnings: aggregation.warnings,
  })

  return {
    status: finalStatus,
    rounds: judgeRoundsCompleted,
    reward: finalReward,
    run: taskRun,
    trajectoryPath: trajectory.cleanPath,
    lastJudgeResult,
    finalResult,
  }
}
