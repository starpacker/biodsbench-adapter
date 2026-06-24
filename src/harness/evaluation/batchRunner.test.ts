import { describe, expect, test } from 'bun:test'
import {
  collectDescendantPids,
  runEvaluationBatch,
  type SpawnEvaluationWorker,
} from './batchRunner.js'

describe('runEvaluationBatch', () => {
  test('collects worker descendants even when shell commands create new process groups', () => {
    const psOutput = [
      '   38    11',
      ' 7594    38',
      ' 7614  7594',
      ' 7615  7614',
      ' 8303    11',
      ' 8767  8303',
    ].join('\n')

    expect(collectDescendantPids(38, psOutput)).toEqual([7594, 7614, 7615])
  })

  test('spawns one worker process per task in source batch mode', async () => {
    const spawned: Array<{ command: string; args: string[]; timeoutMs?: number; env?: Record<string, string> }> = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawned.push({
        command: request.command,
        args: request.args,
        timeoutMs: request.timeoutMs,
        env: request.env,
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
      skillOptions: {
        enabled: true,
        skillsDir: 'skills',
        additionalSkillsDirs: ['output/oracle-skill-ablation/validation/cycle/candidate-skills/skills'],
        allowedSkillNames: ['ci-general-active', 'ci-general-candidate'],
        maxActiveSkills: 2,
        mode: 'native',
      },
      timestamp: '20260513_010203',
      systemPromptPath: 'config/debug-prompt.md',
      workerEnv: { CUDA_VISIBLE_DEVICES: '' },
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
    expect(spawned[0].args).toContain('--enable-skills')
    expect(spawned[0].args).toContain('--skills-dir')
    expect(spawned[0].args).toContain('skills')
    expect(spawned[0].args).toContain('output/oracle-skill-ablation/validation/cycle/candidate-skills/skills')
    expect(spawned[0].args).toContain('--skill-name')
    expect(spawned[0].args).toContain('ci-general-candidate')
    expect(spawned[0].args).toContain('--max-active-skills')
    expect(spawned[0].args).toContain('2')
    expect(spawned[0].timeoutMs).toBe(130000)
    expect(spawned[0].env).toEqual({ CUDA_VISIBLE_DEVICES: '' })
    expect(spawned[1].args).toContain('task_b')
  })

  test('applies per-task runtime overrides to worker args, timeout, and env', async () => {
    const spawned: Array<{ taskId: string; args: string[]; timeoutMs?: number; env?: Record<string, string> }> = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawned.push({
        taskId: request.taskId,
        args: request.args,
        timeoutMs: request.timeoutMs,
        env: request.env,
      })
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['task_a', 'task_b'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 5,
      maxRoundsByTaskId: { task_b: 2 },
      timeoutSeconds: 120,
      timeoutSecondsByTaskId: { task_b: 30 },
      workerTimeoutGraceSeconds: 10,
      concurrency: 2,
      temperature: 1,
      thinking: 'disabled',
      workerEnv: { BASH_MAX_TIMEOUT_MS: '120000' },
      workerEnvByTaskId: { task_b: { BASH_MAX_TIMEOUT_MS: '30000' } },
      verbose: false,
      spawnWorker,
    })

    expect(spawned[0].taskId).toBe('task_a')
    expect(spawned[0].args).toContain('5')
    expect(spawned[0].args).toContain('120')
    expect(spawned[0].timeoutMs).toBe(130000)
    expect(spawned[0].env).toEqual({ BASH_MAX_TIMEOUT_MS: '120000' })

    expect(spawned[1].taskId).toBe('task_b')
    expect(spawned[1].args).toContain('2')
    expect(spawned[1].args).toContain('30')
    expect(spawned[1].timeoutMs).toBe(40000)
    expect(spawned[1].env).toEqual({ BASH_MAX_TIMEOUT_MS: '30000' })
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

  test('does not pass SkillTool flags to workers by default', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['task_a'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      verbose: false,
      spawnWorker,
    })

    expect(spawnedArgs[0]).not.toContain('--enable-skills')
    expect(spawnedArgs[0]).not.toContain('--skills-dir')
  })

  test('passes known task material flags to workers without enabling skills', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['usct_FWI'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      knownTaskMaterials: {
        enabled: true,
        sourceTaskIds: ['ultrasound_sos_tomography', 'seismic_FWI_original'],
      },
      verbose: false,
      spawnWorker,
    })

    expect(spawnedArgs[0]).toContain('--known-task')
    expect(spawnedArgs[0]).toContain('ultrasound_sos_tomography')
    expect(spawnedArgs[0]).toContain('seismic_FWI_original')
    expect(spawnedArgs[0]).not.toContain('--enable-skills')
    expect(spawnedArgs[0]).not.toContain('--skills-dir')
  })

  test('passes known task deep-read flag to workers without enabling skills', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['usct_FWI'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'adaptive',
      knownTaskMaterials: {
        enabled: true,
        sourceTaskIds: ['ultrasound_sos_tomography'],
        deepRead: true,
      },
      verbose: false,
      spawnWorker,
    })

    expect(spawnedArgs[0]).toContain('--known-task')
    expect(spawnedArgs[0]).toContain('ultrasound_sos_tomography')
    expect(spawnedArgs[0]).toContain('--known-task-deep-read')
    expect(spawnedArgs[0]).not.toContain('--enable-skills')
    expect(spawnedArgs[0]).not.toContain('--skills-dir')
  })

  test('passes user prompt files to workers', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['usct_FWI'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      userPromptPaths: [
        'config/prompts/base.md',
        'config/prompts/usct-fwi-known-ab-user-prompt.md',
      ],
      verbose: false,
      spawnWorker,
    })

    const promptArgs = spawnedArgs[0]
      .map((value, index) => (value === '--user-prompt' ? spawnedArgs[0][index + 1] : undefined))
      .filter(Boolean)
    expect(promptArgs).toEqual([
      'config/prompts/base.md',
      'config/prompts/usct-fwi-known-ab-user-prompt.md',
    ])
  })

  test('passes context profile flags to workers', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['target_task'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: true,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
      verbose: false,
      spawnWorker,
    })

    expect(spawnedArgs[0]).toContain('--context-profile')
    expect(spawnedArgs[0]).toContain('eval-safe-claude-parity')
    expect(spawnedArgs[0]).toContain('--network-policy')
    expect(spawnedArgs[0]).toContain('disabled')
    expect(spawnedArgs[0]).toContain('--enable-run-memory')
    expect(spawnedArgs[0]).toContain('--include-claude-default-user-context')
    expect(spawnedArgs[0]).toContain('--disable-agent-tool')
    expect(spawnedArgs[0]).not.toContain('--allow-unsafe-context')
  })

  test('passes enabled AgentTool context flag to workers', async () => {
    const spawnedArgs: string[][] = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawnedArgs.push(request.args)
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['target_task'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 1,
      temperature: 1,
      thinking: 'disabled',
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'enabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: true,
      },
      verbose: false,
      spawnWorker,
    })

    expect(spawnedArgs[0]).toContain('--network-policy')
    expect(spawnedArgs[0]).toContain('enabled')
    expect(spawnedArgs[0]).toContain('--enable-agent-tool')
    expect(spawnedArgs[0]).not.toContain('--disable-agent-tool')
  })

  test('rejects enabled AgentTool under disabled network policy', async () => {
    await expect(
      runEvaluationBatch({
        taskIds: ['target_task'],
        tasksDir: 'tasks',
        runsDir: 'output/runs',
        maxRounds: 1,
        timeoutSeconds: 10,
        concurrency: 1,
        temperature: 1,
        thinking: 'disabled',
        contextOptions: {
          profile: 'eval-minimal',
          networkPolicy: 'disabled',
          runMemory: false,
          recordContextEvents: true,
          reInjectActiveSkillsEachRound: true,
          includeClaudeDefaultUserContext: false,
          enableSlashCommands: false,
          enableMcpClients: false,
          enableAgentTool: true,
        },
        verbose: false,
        spawnWorker: async () => ({ taskId: 'target_task', exitCode: 0 }),
      }),
    ).rejects.toThrow('networkPolicy disabled')
  })

  test('does not allow unsafe Claude context through batch workers', async () => {
    await expect(
      runEvaluationBatch({
        taskIds: ['target_task'],
        tasksDir: 'tasks',
        runsDir: 'output/runs',
        maxRounds: 1,
        timeoutSeconds: 10,
        concurrency: 1,
        temperature: 1,
        thinking: 'disabled',
        contextOptions: {
          profile: 'full-claude-unsafe',
          networkPolicy: 'enabled',
          runMemory: false,
          recordContextEvents: true,
          reInjectActiveSkillsEachRound: true,
          includeClaudeDefaultUserContext: true,
          enableSlashCommands: true,
          enableMcpClients: true,
          enableAgentTool: true,
        },
        verbose: false,
        spawnWorker: async () => ({ taskId: 'target_task', exitCode: 0 }),
      }),
    ).rejects.toThrow('full-claude-unsafe')
  })

  test('uses per-task skill options when provided', async () => {
    const spawned: Array<{ taskId: string; args: string[] }> = []
    const spawnWorker: SpawnEvaluationWorker = async request => {
      spawned.push({ taskId: request.taskId, args: request.args })
      return { taskId: request.taskId, exitCode: 0 }
    }

    await runEvaluationBatch({
      taskIds: ['task_a', 'task_b'],
      tasksDir: 'tasks',
      runsDir: 'output/runs',
      maxRounds: 1,
      timeoutSeconds: 10,
      concurrency: 2,
      temperature: 1,
      thinking: 'disabled',
      verbose: false,
      skillOptionsByTaskId: {
        task_a: {
          enabled: true,
          mode: 'native',
          skillsDir: 'skills',
          allowedSkillNames: ['general-skill', 'task-a-domain'],
          maxActiveSkills: 2,
        },
        task_b: {
          enabled: true,
          mode: 'native',
          skillsDir: 'skills',
          allowedSkillNames: ['general-skill', 'task-b-domain'],
          maxActiveSkills: 2,
        },
      },
      spawnWorker,
    })

    const taskAArgs = spawned.find(item => item.taskId === 'task_a')?.args ?? []
    const taskBArgs = spawned.find(item => item.taskId === 'task_b')?.args ?? []
    expect(taskAArgs).toContain('task-a-domain')
    expect(taskAArgs).not.toContain('task-b-domain')
    expect(taskBArgs).toContain('task-b-domain')
    expect(taskBArgs).not.toContain('task-a-domain')
  })
})
