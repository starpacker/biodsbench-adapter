import { describe, expect, test } from 'bun:test'
import { runEvaluationBatch, type SpawnEvaluationWorker } from './batchRunner.js'

describe('runEvaluationBatch', () => {
  test('spawns one worker process per task in source batch mode', async () => {
    const spawned: Array<{ command: string; args: string[]; timeoutMs?: number }> = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawned.push({
        command: request.command,
        args: request.args,
        timeoutMs: request.timeoutMs,
      })
      return { taskId: request.taskId, exitCode: 0 }
    }

    const result = await runEvaluationBatch({
      taskIds: ['task_a', 'task_b'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 2,
      maxTurnsPerRound: 9,
      timeoutSeconds: 120,
      concurrency: 3,
      workerTimeoutGraceSeconds: 10,
      temperature: 0.2,
      thinking: 'adaptive',
      timestamp: '20260513_010203',
      systemPromptPath: 'config/debug-prompt.md',
      verbose: false,
      spawnWorker,
    })

    expect(result.ok).toBe(true)
    expect(spawned).toHaveLength(2)
    expect(spawned[0].args).toContain('--worker-run')
    expect(spawned[0].args).toContain('--task')
    expect(spawned[0].args).toContain('task_a')
    expect(spawned[0].args).toContain('--max-turns-per-round')
    expect(spawned[0].args).toContain('9')
    expect(spawned[0].args).toContain('--temperature')
    expect(spawned[0].args).toContain('0.2')
    expect(spawned[0].args).toContain('--thinking')
    expect(spawned[0].args).toContain('adaptive')
    expect(spawned[0].timeoutMs).toBe(130000)
    expect(spawned[1].args).toContain('task_b')
  })

  test('runs workers as a fixed-size pipeline', async () => {
    const started: string[] = []
    const resolvers = new Map<string, (exitCode: number) => void>()
    const spawnWorker: SpawnEvaluationWorker = request => {
      started.push(request.taskId)
      return new Promise(resolve => {
        resolvers.set(request.taskId, exitCode =>
          resolve({ taskId: request.taskId, exitCode }),
        )
      })
    }

    const running = runEvaluationBatch({
      taskIds: ['a', 'b', 'c', 'd', 'e'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 120,
      concurrency: 3,
      temperature: 1,
      thinking: 'disabled',
      verbose: false,
      spawnWorker,
    })

    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'c'])

    resolvers.get('b')?.(0)
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'c', 'd'])

    resolvers.get('a')?.(0)
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e'])

    for (const taskId of ['c', 'd', 'e']) {
      resolvers.get(taskId)?.(0)
    }
    const result = await running
    expect(result.ok).toBe(true)
    expect(result.workers.map(worker => worker.taskId)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('continues launching queued workers after a worker fails', async () => {
    const started: string[] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      started.push(request.taskId)
      return { taskId: request.taskId, exitCode: request.taskId === 'a' ? 1 : 0 }
    }

    const result = await runEvaluationBatch({
      taskIds: ['a', 'b', 'c'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 120,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      verbose: false,
      spawnWorker,
    })

    expect(started).toEqual(['a', 'b', 'c'])
    expect(result.ok).toBe(false)
    expect(result.workers.map(worker => worker.exitCode)).toEqual([1, 0, 0])
  })

  test('passes worker watchdog timeout to spawned workers', async () => {
    const timeouts: Array<number | undefined> = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      timeouts.push(request.timeoutMs)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['task_a'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      workerTimeoutGraceSeconds: 7,
      concurrency: 3,
      temperature: 1,
      thinking: 'disabled',
      verbose: false,
      spawnWorker,
    })

    expect(timeouts).toEqual([17000])
  })
})
