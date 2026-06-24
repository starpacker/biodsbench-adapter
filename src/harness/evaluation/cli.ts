import { readFile } from 'fs/promises'
import { join } from 'path'
import { runEvaluationBatch } from './batchRunner.js'
import { DefaultJudgeRunner } from './judgeRunner.js'
import {
  DEFAULT_EVALUATION_NETWORK_POLICY,
  validateEvaluationNetworkPolicy,
} from './networkPolicy.js'
import { runSourceTaskLoop } from './sourceTaskLoop.js'
import type {
  EvaluationContextOptions,
  EvaluationNetworkPolicy,
  EvaluationContextProfile,
  EvaluationSkillOptions,
  EvaluationThinkingMode,
  JudgeFeedbackLevel,
  KnownTaskMaterialsOptions,
  LoopStatus,
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
  userPromptPaths: string[]
  timestamp?: string
  verbose: boolean
  agentRuntime: AgentRuntime
  workerRun: boolean
  temperature: number
  thinking: EvaluationThinkingMode
  judgeFeedbackLevel?: JudgeFeedbackLevel
  skillOptions: EvaluationSkillOptions
  contextOptions: EvaluationContextOptions
  knownTaskMaterials: KnownTaskMaterialsOptions
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
    '  --judge-feedback-level overall_only|case_only|metric_status|metric_value|metric_full',
    '  --context-profile eval-minimal|eval-safe-claude-parity|full-claude-unsafe',
    '  --enable-run-memory       Persist run-local memory between judge rounds',
    '  --resume-run <run_dir>     Resume from an existing run directory and enable run memory',
    '  --disable-context-events   Do not record context/compaction events',
    '  --disable-auto-compact     Disable Claude auto-compact for compatibility debugging',
    '  --disable-skill-reinject   Do not re-inject active skill reminders each judge round',
    '  --include-claude-default-user-context  Include Claude Code default user context in safe parity mode',
    '  --enable-slash-commands    Enable eval-safe slash command allowlist',
    '  --enable-mcp               Enable eval-safe MCP allowlist',
    '  --network-policy disabled|enabled  Harness network policy (default: disabled)',
    '  --enable-agent-tool        Enable eval-safe AgentTool allowlist (requires --network-policy enabled; default: disabled)',
    '  --disable-agent-tool       Disable AgentTool for this run',
    '  --allow-unsafe-context     Required with full-claude-unsafe context profile',
    '  --enable-skills             Enable native SkillTool for source runtime (default: disabled)',
    '  --skills-dir <path>         Native skills directory when skills are enabled; repeat for overlays (default: skills)',
    '  --skill-name <name>         Restrict native SkillTool to a specific skill name; repeatable',
    '  --max-active-skills <n>     Maximum native skills exposed to the run after filtering',
    '  --known-task <task_id>      Copy README.md, std_code/main.py, and std_code/src/ from a prior task into public/known_tasks/; repeatable',
    '  --known-task-deep-read      Ask the source agent to inspect exposed known-task materials before implementation',
    '  --system-prompt <path>      Optional debug-only extra system prompt file (default: none)',
    '  --user-prompt <path>        Optional task-specific user prompt file; repeatable',
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

function defaultContextOptions(): EvaluationContextOptions {
  return {
    profile: 'eval-minimal',
    runMemory: false,
    recordContextEvents: true,
    reInjectActiveSkillsEachRound: true,
    includeClaudeDefaultUserContext: false,
    enableSlashCommands: false,
    enableMcpClients: false,
    networkPolicy: DEFAULT_EVALUATION_NETWORK_POLICY,
    enableAgentTool: false,
    disableAutoCompact: false,
  }
}

function parseContextProfile(value: string, name: string): EvaluationContextProfile {
  if (
    value !== 'eval-minimal' &&
    value !== 'eval-safe-claude-parity' &&
    value !== 'full-claude-unsafe'
  ) {
    throw new Error(`${name} must be eval-minimal, eval-safe-claude-parity, or full-claude-unsafe, got: ${value}`)
  }
  return value
}

function parseNetworkPolicy(value: string, name: string): EvaluationNetworkPolicy {
  if (value !== 'disabled' && value !== 'enabled') {
    throw new Error(`${name} must be disabled or enabled, got: ${value}`)
  }
  return value
}

function parseJudgeFeedbackLevel(value: string, name: string): JudgeFeedbackLevel {
  if (
    value !== 'overall_only' &&
    value !== 'case_only' &&
    value !== 'metric_status' &&
    value !== 'metric_value' &&
    value !== 'metric_full'
  ) {
    throw new Error(
      `${name} must be overall_only, case_only, metric_status, metric_value, or metric_full, got: ${value}`,
    )
  }
  return value
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
  const userPromptPaths: string[] = []
  let timestamp: string | undefined
  let verbose = true
  let agentRuntime: AgentRuntime = 'source'
  let workerRun = false
  let temperature = 1
  let thinking: EvaluationThinkingMode = 'disabled'
  let judgeFeedbackLevel: JudgeFeedbackLevel | undefined
  const skillOptions: EvaluationSkillOptions = {
    enabled: false,
    skillsDir: 'skills',
    mode: 'native',
  }
  const knownTaskMaterials: KnownTaskMaterialsOptions = {
    enabled: false,
    sourceTaskIds: [],
  }
  const contextOptions = defaultContextOptions()
  let allowUnsafeContext = false
  let skillsDirProvided = false
  let skillNameProvided = false
  let maxActiveSkillsProvided = false

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
    if (arg === '--judge-feedback-level') {
      judgeFeedbackLevel = parseJudgeFeedbackLevel(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--context-profile') {
      contextOptions.profile = parseContextProfile(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--enable-run-memory') {
      contextOptions.runMemory = true
      continue
    }
    if (arg === '--resume-run') {
      contextOptions.resumeRun = readOption(args, index, arg)
      contextOptions.runMemory = true
      index++
      continue
    }
    if (arg === '--disable-context-events') {
      contextOptions.recordContextEvents = false
      continue
    }
    if (arg === '--disable-auto-compact') {
      contextOptions.disableAutoCompact = true
      continue
    }
    if (arg === '--disable-skill-reinject') {
      contextOptions.reInjectActiveSkillsEachRound = false
      continue
    }
    if (arg === '--include-claude-default-user-context') {
      contextOptions.includeClaudeDefaultUserContext = true
      continue
    }
    if (arg === '--enable-slash-commands') {
      contextOptions.enableSlashCommands = true
      continue
    }
    if (arg === '--enable-mcp') {
      contextOptions.enableMcpClients = true
      continue
    }
    if (arg === '--network-policy') {
      contextOptions.networkPolicy = parseNetworkPolicy(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--enable-agent-tool') {
      contextOptions.enableAgentTool = true
      continue
    }
    if (arg === '--disable-agent-tool') {
      contextOptions.enableAgentTool = false
      continue
    }
    if (arg === '--allow-unsafe-context') {
      allowUnsafeContext = true
      continue
    }
    if (arg === '--enable-skills') {
      skillOptions.enabled = true
      continue
    }
    if (arg === '--skills-dir') {
      const dir = readOption(args, index, arg)
      if (!skillsDirProvided) {
        skillOptions.skillsDir = dir
      } else {
        skillOptions.additionalSkillsDirs = [...(skillOptions.additionalSkillsDirs ?? []), dir]
      }
      skillsDirProvided = true
      index++
      continue
    }
    if (arg === '--skill-name') {
      skillNameProvided = true
      skillOptions.allowedSkillNames = [...(skillOptions.allowedSkillNames ?? []), readOption(args, index, arg)]
      index++
      continue
    }
    if (arg === '--max-active-skills') {
      maxActiveSkillsProvided = true
      skillOptions.maxActiveSkills = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--known-task') {
      knownTaskMaterials.enabled = true
      knownTaskMaterials.sourceTaskIds.push(readOption(args, index, arg))
      index++
      continue
    }
    if (arg === '--known-task-deep-read') {
      knownTaskMaterials.deepRead = true
      continue
    }
    if (arg === '--system-prompt') {
      systemPromptPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--user-prompt') {
      userPromptPaths.push(readOption(args, index, arg))
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
  if (skillsDirProvided && !skillOptions.enabled) {
    throw new Error('--skills-dir requires --enable-skills')
  }
  if (skillNameProvided && !skillOptions.enabled) {
    throw new Error('--skill-name requires --enable-skills')
  }
  if (maxActiveSkillsProvided && !skillOptions.enabled) {
    throw new Error('--max-active-skills requires --enable-skills')
  }
  if (knownTaskMaterials.deepRead && knownTaskMaterials.sourceTaskIds.length === 0) {
    throw new Error('--known-task-deep-read requires at least one --known-task')
  }
  if (contextOptions.profile === 'full-claude-unsafe') {
    if (!allowUnsafeContext) {
      throw new Error('full-claude-unsafe requires --allow-unsafe-context')
    }
    contextOptions.includeClaudeDefaultUserContext = true
  }
  validateEvaluationNetworkPolicy(contextOptions)

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
    userPromptPaths,
    timestamp,
    verbose,
    agentRuntime,
    workerRun,
    temperature,
    thinking,
    judgeFeedbackLevel,
    skillOptions,
    contextOptions,
    knownTaskMaterials,
  }
}

async function readSystemPrompt(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  return readFile(path, 'utf8')
}

async function readUserPrompt(paths: string[]): Promise<string | undefined> {
  if (paths.length === 0) return undefined
  const parts = await Promise.all(
    paths.map(async path => {
      const content = (await readFile(path, 'utf8')).trim()
      return [`# User prompt file: ${path}`, content].join('\n')
    }),
  )
  return parts.join('\n\n---\n\n')
}

export function exitCodeForLoopStatus(status: LoopStatus): number {
  return status === 'success' ? 0 : 1
}

export function configureEvaluationBashTimeoutEnv(timeoutSeconds: number): void {
  const capMs = Math.max(1, Math.floor(timeoutSeconds * 1000))
  const existing = Number(process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS)
  if (Number.isFinite(existing) && existing > 0 && existing <= capMs) return
  process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS = String(capMs)
}

async function main(): Promise<void> {
  const parsed = parseEvaluationCliArgs(process.argv.slice(2))
  configureEvaluationBashTimeoutEnv(parsed.timeoutSeconds)
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
      judgeFeedbackLevel: parsed.judgeFeedbackLevel,
      skillOptions: parsed.skillOptions,
      contextOptions: parsed.contextOptions,
      knownTaskMaterials: parsed.knownTaskMaterials,
      systemPromptPath: parsed.systemPromptPath,
      userPromptPaths: parsed.userPromptPaths,
      timestamp: parsed.timestamp,
      verbose: parsed.verbose,
    })
    process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
    process.exitCode = batch.ok ? 0 : 1
    return
  }

  const systemPrompt = await readSystemPrompt(parsed.systemPromptPath)
  const userPrompt = await readUserPrompt(parsed.userPromptPaths)
  const result = await runSourceTaskLoop({
    taskId: parsed.taskId,
    tasksDir: parsed.tasksDir,
    runsDir: parsed.runsDir,
    maxRounds: parsed.maxRounds,
    maxTurnsPerRound: parsed.maxTurnsPerRound,
    timeoutSeconds: parsed.timeoutSeconds,
    timestamp: parsed.timestamp,
    systemPrompt,
    userPrompt,
    verbose: parsed.verbose,
    llmOptions: {
      temperature: parsed.temperature,
      thinking: parsed.thinking,
    },
    judgeFeedbackLevel: parsed.judgeFeedbackLevel,
    skillOptions: parsed.skillOptions,
    contextOptions: parsed.contextOptions,
    knownTaskMaterials: parsed.knownTaskMaterials,
    judge: new DefaultJudgeRunner(),
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
  let exitCode = 0
  try {
    await main()
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Usage:')) {
      process.stdout.write(`${message}\n`)
      exitCode = 0
    } else {
      process.stderr.write(`${message}\n`)
      exitCode = 1
    }
  }
  process.exit(exitCode)
}
