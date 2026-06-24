import type {
  EvaluationContextOptions,
  EvaluationSkillOptions,
  JudgeFeedbackLevel,
  KnownTaskMaterialsOptions,
} from './types.js'
import {
  normalizeEvaluationNetworkPolicy,
  validateEvaluationNetworkPolicy,
} from './networkPolicy.js'
import {
  collectDescendantPids,
  terminateSpawnedProcessTree,
} from './processTree.js'

export { collectDescendantPids }

export type EvaluationWorkerRequest = {
  taskId: string
  command: string
  args: string[]
  timeoutMs?: number
  env?: Record<string, string>
}

export type EvaluationWorkerResult = {
  taskId: string
  exitCode: number
}

export type SpawnEvaluationWorker = (
  request: EvaluationWorkerRequest,
) => Promise<EvaluationWorkerResult>

export type RunEvaluationBatchInput = {
  taskIds: string[]
  tasksDir: string
  runsDir: string
  maxRounds: number
  maxRoundsByTaskId?: Record<string, number>
  maxTurnsPerRound?: number
  timeoutSeconds: number
  timeoutSecondsByTaskId?: Record<string, number>
  temperature: number
  thinking: 'disabled' | 'adaptive'
  judgeFeedbackLevel?: JudgeFeedbackLevel
  skillOptions?: EvaluationSkillOptions
  skillOptionsByTaskId?: Record<string, EvaluationSkillOptions>
  contextOptions?: EvaluationContextOptions
  knownTaskMaterials?: KnownTaskMaterialsOptions
  systemPromptPath?: string
  userPromptPaths?: string[]
  timestamp?: string
  concurrency?: number
  workerTimeoutGraceSeconds?: number
  workerEnv?: Record<string, string>
  workerEnvByTaskId?: Record<string, Record<string, string>>
  verbose: boolean
  spawnWorker?: SpawnEvaluationWorker
}

export type RunEvaluationBatchResult = {
  ok: boolean
  workers: EvaluationWorkerResult[]
}

function pushOption(args: string[], name: string, value: string | number | undefined): void {
  if (value === undefined) return
  args.push(name, String(value))
}

function pushContextOptions(args: string[], options: EvaluationContextOptions | undefined): void {
  if (!options) return
  pushOption(args, '--network-policy', normalizeEvaluationNetworkPolicy(options.networkPolicy))
  if (options.profile !== 'eval-minimal') {
    pushOption(args, '--context-profile', options.profile)
  }
  if (options.runMemory) args.push('--enable-run-memory')
  pushOption(args, '--resume-run', options.resumeRun)
  if (!options.recordContextEvents) args.push('--disable-context-events')
  if (!options.reInjectActiveSkillsEachRound) args.push('--disable-skill-reinject')
  if (options.includeClaudeDefaultUserContext) args.push('--include-claude-default-user-context')
  if (options.enableSlashCommands) args.push('--enable-slash-commands')
  if (options.enableMcpClients) args.push('--enable-mcp')
  if (options.enableAgentTool === true) args.push('--enable-agent-tool')
  if (options.enableAgentTool === false) args.push('--disable-agent-tool')
  if (options.disableAutoCompact) args.push('--disable-auto-compact')
}

function workerArgs(input: RunEvaluationBatchInput, taskId: string): string[] {
  const args = [
    'src/harness/evaluation/cli.ts',
    '--worker-run',
    '--agent-runtime',
    'source',
    '--task',
    taskId,
  ]
  pushOption(args, '--tasks-dir', input.tasksDir)
  pushOption(args, '--runs-dir', input.runsDir)
  pushOption(args, '--max-rounds', input.maxRoundsByTaskId?.[taskId] ?? input.maxRounds)
  pushOption(args, '--max-turns-per-round', input.maxTurnsPerRound)
  pushOption(args, '--timeout-seconds', input.timeoutSecondsByTaskId?.[taskId] ?? input.timeoutSeconds)
  pushOption(args, '--judge-feedback-level', input.judgeFeedbackLevel)
  pushOption(args, '--temperature', input.temperature)
  pushOption(args, '--thinking', input.thinking)
  const skillOptions = input.skillOptionsByTaskId?.[taskId] ?? input.skillOptions
  if (skillOptions?.enabled) {
    args.push('--enable-skills')
    pushOption(args, '--skills-dir', skillOptions.skillsDir)
    for (const dir of skillOptions.additionalSkillsDirs ?? []) {
      pushOption(args, '--skills-dir', dir)
    }
    for (const name of skillOptions.allowedSkillNames ?? []) {
      pushOption(args, '--skill-name', name)
    }
    pushOption(args, '--max-active-skills', skillOptions.maxActiveSkills)
  }
  if (input.knownTaskMaterials?.enabled) {
    for (const sourceTaskId of input.knownTaskMaterials.sourceTaskIds) {
      pushOption(args, '--known-task', sourceTaskId)
    }
    if (input.knownTaskMaterials.deepRead) args.push('--known-task-deep-read')
  }
  pushContextOptions(args, input.contextOptions)
  pushOption(args, '--system-prompt', input.systemPromptPath)
  for (const path of input.userPromptPaths ?? []) {
    pushOption(args, '--user-prompt', path)
  }
  pushOption(args, '--timestamp', input.timestamp)
  if (!input.verbose) args.push('--quiet')
  return args
}

const defaultSpawnWorker: SpawnEvaluationWorker = request => {
  const child = Bun.spawn([request.command, ...request.args], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: request.env ? { ...process.env, ...request.env } : process.env,
  })
  const exited = child.exited.then(exitCode => ({
    taskId: request.taskId,
    exitCode,
  }))
  if (!request.timeoutMs) return exited

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<EvaluationWorkerResult>(resolve => {
    timeoutTimer = setTimeout(() => {
      terminateSpawnedProcessTree(child, 'SIGTERM')
      let resolved = false
      const resolveTimeout = () => {
        if (resolved) return
        resolved = true
        resolve({ taskId: request.taskId, exitCode: 124 })
      }
      killTimer = setTimeout(() => {
        terminateSpawnedProcessTree(child, 'SIGKILL')
        resolveTimeout()
      }, 5000)
      void child.exited.finally(() => {
        if (killTimer) clearTimeout(killTimer)
        resolveTimeout()
      })
    }, request.timeoutMs)
  })

  void child.exited.finally(() => {
    if (killTimer) clearTimeout(killTimer)
  })

  return Promise.race([exited, timeout]).finally(() => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
  })
}

export async function runEvaluationBatch(
  input: RunEvaluationBatchInput,
): Promise<RunEvaluationBatchResult> {
  if (input.contextOptions?.profile === 'full-claude-unsafe') {
    throw new Error('full-claude-unsafe is not allowed in batch evaluation workers; use direct CLI debugging with --allow-unsafe-context')
  }
  validateEvaluationNetworkPolicy(input.contextOptions)
  const spawnWorker = input.spawnWorker ?? defaultSpawnWorker
  const command = process.execPath
  const concurrency = Math.max(1, input.concurrency ?? 3)
  const workers: Array<EvaluationWorkerResult | undefined> = new Array(
    input.taskIds.length,
  )
  let nextIndex = 0

  async function runLane(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex++
      if (index >= input.taskIds.length) return

      const taskId = input.taskIds[index]
      const timeoutSeconds = input.timeoutSecondsByTaskId?.[taskId] ?? input.timeoutSeconds
      const timeoutMs =
        (timeoutSeconds + (input.workerTimeoutGraceSeconds ?? 60)) * 1000
      const taskEnv = input.workerEnvByTaskId?.[taskId]
      const env = taskEnv ? { ...(input.workerEnv ?? {}), ...taskEnv } : input.workerEnv
      try {
        workers[index] = await spawnWorker({
          taskId,
          command,
          args: workerArgs(input, taskId),
          timeoutMs,
          env,
        })
      } catch {
        workers[index] = { taskId, exitCode: 1 }
      }
    }
  }

  const laneCount = Math.min(concurrency, input.taskIds.length)
  await Promise.all(Array.from({ length: laneCount }, () => runLane()))

  const completedWorkers = workers.map((worker, index) =>
    worker ?? {
      taskId: input.taskIds[index],
      exitCode: 1,
    },
  )
  return {
    ok: completedWorkers.every(worker => worker.exitCode === 0),
    workers: completedWorkers,
  }
}
