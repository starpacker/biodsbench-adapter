import { readFile } from 'fs/promises'
import { join } from 'path'
import { runEvaluationBatch } from './batchRunner.js'
import { DefaultJudgeRunner } from './judgeRunner.js'
import { runSourceTaskLoop } from './sourceTaskLoop.js'
import type {
  EvaluationThinkingMode,
  LoopStatus,
  PriorSubtaskContext,
} from './types.js'

export type AgentRuntime = 'source'

export type EvaluationCliArgs = {
  taskId: string
  taskIds: string[]
  tasksDir: string
  runsDir: string
  maxRounds: number
  maxTurnsPerRound?: number
  timeoutSeconds: number
  concurrency: number
  workerTimeoutGraceSeconds?: number
  systemPromptPath?: string
  priorContextPath?: string
  timestamp?: string
  verbose: boolean
  agentRuntime: AgentRuntime
  workerRun: boolean
  temperature: number
  thinking: EvaluationThinkingMode
}

function usage(): string {
  return [
    'Usage:',
    '  bun src/harness/evaluation/cli.ts --task <task_id> [options]',
    '',
    'Options:',
    '  --tasks-dir <path>          Task prototypes directory (default: tasks)',
    '  --runs-dir <path>           Run output directory (default: $AGENT_LOG_DIR/runs or output/runs)',
    '  --max-rounds <n>            Maximum judge rounds (default: 3)',
    '  --max-turns-per-round <n>   Optional QueryEngine turn cap per judge round (default: unlimited)',
    '  --timeout-seconds <n>       Whole-loop timeout (default: 1800)',
    '  --concurrency <n>           Maximum source workers to run at once (default: 3)',
    '  --worker-timeout-grace-seconds <n>  Worker shutdown grace after loop timeout (default: 60)',
    '  --agent-runtime source      Agent runtime; legacy subprocess runtime has been removed',
    '  --temperature <number>      Model temperature when thinking is disabled (default: 1)',
    '  --thinking disabled|adaptive  Thinking mode for source runtime (default: disabled)',
    '  --system-prompt <path>      Optional debug-only extra system prompt file (default: none)',
    '  --prior-context <path>      JSON file with prior sub-task context for true-serial evaluation',
    '                              (array of {taskId,status,passed,description,generatedCode,judgeFeedback,notes})',
    '  --timestamp <value>         Stable timestamp/run suffix for reproducible tests',
    '  --quiet                     Do not print live run events to stderr',
  ].join('\n')
}

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value after ${name}`)
  }
  return value
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  }
  return parsed
}

function parseTemperature(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got: ${value}`)
  }
  return parsed
}

export function parseEvaluationCliArgs(args: string[]): EvaluationCliArgs {
  let taskId = ''
  const taskIds: string[] = []
  let tasksDir = 'tasks'
  let runsDir = join(process.env.AGENT_LOG_DIR || 'output', 'runs')
  let maxRounds = 3
  let maxTurnsPerRound: number | undefined
  let timeoutSeconds = 1800
  let concurrency = 3
  let workerTimeoutGraceSeconds: number | undefined
  let systemPromptPath: string | undefined
  let priorContextPath: string | undefined
  let timestamp: string | undefined
  let verbose = true
  let agentRuntime: AgentRuntime = 'source'
  let workerRun = false
  let temperature = 1
  let thinking: EvaluationThinkingMode = 'disabled'

  function addTaskIds(value: string): void {
    for (const id of value.split(',').map(item => item.trim()).filter(Boolean)) {
      if (taskIds.length === 0) taskId = id
      taskIds.push(id)
    }
  }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    }
    if (arg === '--task') {
      addTaskIds(readOption(args, index, arg))
      index++
      continue
    }
    if (arg === '--tasks-dir') {
      tasksDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--runs-dir') {
      runsDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--max-rounds') {
      maxRounds = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--max-turns-per-round') {
      maxTurnsPerRound = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--timeout-seconds') {
      timeoutSeconds = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--concurrency') {
      concurrency = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--worker-timeout-grace-seconds') {
      workerTimeoutGraceSeconds = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--agent-runtime') {
      const runtime = readOption(args, index, arg)
      if (runtime === 'legacy-subprocess') {
        throw new Error('legacy-subprocess has been removed; use --agent-runtime source')
      }
      if (runtime !== 'source') {
        throw new Error(`Unknown agent runtime: ${runtime}`)
      }
      agentRuntime = runtime
      index++
      continue
    }
    if (arg === '--temperature') {
      temperature = parseTemperature(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--thinking') {
      const value = readOption(args, index, arg)
      if (value !== 'disabled' && value !== 'adaptive') {
        throw new Error(`${arg} must be disabled or adaptive, got: ${value}`)
      }
      thinking = value
      index++
      continue
    }
    if (arg === '--system-prompt') {
      systemPromptPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--prior-context') {
      priorContextPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--timestamp') {
      timestamp = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--quiet') {
      verbose = false
      continue
    }
    if (arg === '--worker-run') {
      workerRun = true
      continue
    }
    if (!arg.startsWith('--') && taskIds.length === 0) {
      addTaskIds(arg)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!taskId) {
    throw new Error(`Missing required --task.\n\n${usage()}`)
  }

  return {
    taskId,
    taskIds,
    tasksDir,
    runsDir,
    maxRounds,
    maxTurnsPerRound,
    timeoutSeconds,
    concurrency,
    workerTimeoutGraceSeconds,
    systemPromptPath,
    priorContextPath,
    timestamp,
    verbose,
    agentRuntime,
    workerRun,
    temperature,
    thinking,
  }
}

async function readSystemPrompt(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  return readFile(path, 'utf8')
}

/**
 * Read a prior-context JSON file written by a serial orchestrator and normalise
 * it into a `PriorSubtaskContext[]`. The file may either be a bare array of
 * records or an object with a `priorSubtasks` field (the latter lets the
 * orchestrator add metadata alongside the array).
 *
 * Returns `undefined` if no path was supplied. Throws with a clear message if
 * the file exists but cannot be parsed/validated, so the CLI fails fast rather
 * than silently dropping context.
 */
async function readPriorContext(
  path: string | undefined,
): Promise<PriorSubtaskContext[] | undefined> {
  if (!path) return undefined
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`--prior-context: invalid JSON in ${path}: ${message}`)
  }
  const candidate =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { priorSubtasks?: unknown }).priorSubtasks)
        ? (parsed as { priorSubtasks: unknown[] }).priorSubtasks
        : undefined
  if (!candidate) {
    throw new Error(
      `--prior-context: ${path} must be an array of prior-subtask records or an object with a 'priorSubtasks' array.`,
    )
  }
  const result: PriorSubtaskContext[] = []
  for (let i = 0; i < candidate.length; i++) {
    const item = candidate[i]
    if (!item || typeof item !== 'object') {
      throw new Error(`--prior-context: entry [${i}] in ${path} is not an object.`)
    }
    const rec = item as Record<string, unknown>
    const taskId = rec.taskId ?? rec.task_id
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw new Error(`--prior-context: entry [${i}] in ${path} is missing 'taskId'.`)
    }
    const taskIdxRaw = rec.taskIdx ?? rec.task_idx
    const taskIdx =
      typeof taskIdxRaw === 'number' && Number.isFinite(taskIdxRaw) ? taskIdxRaw : undefined
    const status = typeof rec.status === 'string' ? rec.status : undefined
    const passed = typeof rec.passed === 'boolean' ? rec.passed : undefined
    const description = typeof rec.description === 'string' ? rec.description : undefined
    const generatedCodeRaw = rec.generatedCode ?? rec.generated_code
    const generatedCode = typeof generatedCodeRaw === 'string' ? generatedCodeRaw : undefined
    const judgeFeedbackRaw = rec.judgeFeedback ?? rec.judge_feedback
    const judgeFeedback = typeof judgeFeedbackRaw === 'string' ? judgeFeedbackRaw : undefined
    const notes = typeof rec.notes === 'string' ? rec.notes : undefined
    result.push({
      taskId,
      taskIdx,
      status,
      passed,
      description,
      generatedCode,
      judgeFeedback,
      notes,
    })
  }
  return result.length > 0 ? result : undefined
}

export function exitCodeForLoopStatus(status: LoopStatus): number {
  return status === 'success' ? 0 : 1
}

async function main(): Promise<void> {
  const parsed = parseEvaluationCliArgs(process.argv.slice(2))
  if (parsed.taskIds.length > 1 && !parsed.workerRun) {
    const batch = await runEvaluationBatch({
      taskIds: parsed.taskIds,
      tasksDir: parsed.tasksDir,
      runsDir: parsed.runsDir,
      maxRounds: parsed.maxRounds,
      maxTurnsPerRound: parsed.maxTurnsPerRound,
      timeoutSeconds: parsed.timeoutSeconds,
      concurrency: parsed.concurrency,
      workerTimeoutGraceSeconds: parsed.workerTimeoutGraceSeconds,
      temperature: parsed.temperature,
      thinking: parsed.thinking,
      systemPromptPath: parsed.systemPromptPath,
      timestamp: parsed.timestamp,
      verbose: parsed.verbose,
    })
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
    process.exitCode = batch.ok ? 0 : 1
    return
  }

  const systemPrompt = await readSystemPrompt(parsed.systemPromptPath)
  const priorSubtasks = await readPriorContext(parsed.priorContextPath)
  const result = await runSourceTaskLoop({
    taskId: parsed.taskId,
    tasksDir: parsed.tasksDir,
    runsDir: parsed.runsDir,
    maxRounds: parsed.maxRounds,
    maxTurnsPerRound: parsed.maxTurnsPerRound,
    timeoutSeconds: parsed.timeoutSeconds,
    timestamp: parsed.timestamp,
    systemPrompt,
    verbose: parsed.verbose,
    llmOptions: {
      temperature: parsed.temperature,
      thinking: parsed.thinking,
    },
    judge: new DefaultJudgeRunner(),
    priorSubtasks,
  })

  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        rounds: result.rounds,
        reward: result.reward,
        run_dir: result.run.runDir,
        trajectory_path: result.trajectoryPath,
        last_judge_status: result.lastJudgeResult?.status,
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = exitCodeForLoopStatus(result.status)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Usage:')) {
      process.stdout.write(`${message}\n`)
      process.exitCode = 0
    } else {
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    }
  }
}
