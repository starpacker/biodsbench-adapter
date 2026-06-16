export type EvaluationWorkerRequest = {
  taskId: string
  command: string
  args: string[]
  timeoutMs?: number
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
  maxTurnsPerRound?: number
  timeoutSeconds: number
  temperature: number
  thinking: 'disabled' | 'adaptive'
  systemPromptPath?: string
  timestamp?: string
  concurrency?: number
  workerTimeoutGraceSeconds?: number
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
  pushOption(args, '--max-rounds', input.maxRounds)
  pushOption(args, '--max-turns-per-round', input.maxTurnsPerRound)
  pushOption(args, '--timeout-seconds', input.timeoutSeconds)
  pushOption(args, '--temperature', input.temperature)
  pushOption(args, '--thinking', input.thinking)
  pushOption(args, '--system-prompt', input.systemPromptPath)
  pushOption(args, '--timestamp', input.timestamp)
  if (!input.verbose) args.push('--quiet')
  return args
}

const defaultSpawnWorker: SpawnEvaluationWorker = request => {
  const child = Bun.spawn([request.command, ...request.args], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  const exited = child.exited.then(exitCode => ({
    taskId: request.taskId,
    exitCode,
  }))
  if (!request.timeoutMs) return exited

  let timedOut = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<EvaluationWorkerResult>(resolve => {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref?.()
      resolve({ taskId: request.taskId, exitCode: 124 })
    }, request.timeoutMs)
    timeoutTimer.unref?.()
  })

  void child.exited.finally(() => {
    if (killTimer) clearTimeout(killTimer)
  })

  return Promise.race([exited, timeout]).finally(() => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (!timedOut && killTimer) clearTimeout(killTimer)
  })
}

export async function runEvaluationBatch(
  input: RunEvaluationBatchInput,
): Promise<RunEvaluationBatchResult> {
  const spawnWorker = input.spawnWorker ?? defaultSpawnWorker
  const command = process.execPath
  const concurrency = Math.max(1, input.concurrency ?? 3)
  const timeoutMs =
    (input.timeoutSeconds + (input.workerTimeoutGraceSeconds ?? 60)) * 1000
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
      try {
        workers[index] = await spawnWorker({
          taskId,
          command,
          args: workerArgs(input, taskId),
          timeoutMs,
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
