import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { runSourceTaskLoop } from './sourceTaskLoop.js'
import type {
  JudgeRunner,
  SourceAgentSession,
  SourceAgentTurnInput,
} from './types.js'

async function makeTask(root: string, taskId: string, withRuntime = false): Promise<void> {
  const taskDir = join(root, taskId)
  await mkdir(join(taskDir, 'visible_data'), { recursive: true })
  await mkdir(join(taskDir, 'evaluation'), { recursive: true })
  await writeFile(join(taskDir, 'README.md'), '# Demo\n', 'utf8')
  await writeFile(join(taskDir, 'visible_data', 'cases.json'), '[]', 'utf8')
  await writeFile(join(taskDir, 'evaluation', 'judge.py'), '', 'utf8')
  if (withRuntime) {
    const pythonRel =
      process.platform === 'win32'
        ? 'envs/runtime/.venv/Scripts/python.exe'
        : 'envs/runtime/.venv-posix/bin/python'
    const pythonAbs = join(taskDir, ...pythonRel.split('/'))
    await mkdir(dirname(pythonAbs), { recursive: true })
    await writeFile(pythonAbs, '', 'utf8')
    await mkdir(join(taskDir, 'envs'), { recursive: true })
    await writeFile(
      join(taskDir, 'envs', 'env_manifest.json'),
      JSON.stringify({
        default_env: 'runtime',
        envs: {
          runtime: {
            python: {
              [process.platform === 'win32' ? 'windows' : 'posix']: pythonRel,
            },
          },
        },
      }),
      'utf8',
    )
  }
  await writeFile(
    join(taskDir, 'task_manifest.json'),
    JSON.stringify({
      version: 1,
      task_id: taskId,
      public_bundle: withRuntime
        ? ['README.md', 'visible_data/', 'envs/']
        : ['README.md', 'visible_data/'],
      private_judge_bundle: ['evaluation/'],
      entrypoints: withRuntime ? { environment: 'envs/env_manifest.json' } : {},
      submission: { output_dir: 'outputs' },
    }),
    'utf8',
  )
}

describe('runSourceTaskLoop', () => {
  test('interrupts and closes agent event generator when agent inference times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-timeout-close-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'timeout_close_task', true)
    let generatorClosed = false
    let interrupted = false
    let disposed = false
    let releaseGenerator!: () => void

    async function* hangingSubmit() {
      try {
        await new Promise<void>(resolve => {
          releaseGenerator = resolve
        })
      } finally {
        generatorClosed = true
      }
    }

    const result = await runSourceTaskLoop({
      taskId: 'timeout_close_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 1,
      sessionDisposeGraceMs: 50,
      sessionFactory: async () => ({
        submit: hangingSubmit,
        interrupt() {
          interrupted = true
          releaseGenerator()
        },
        async dispose() {
          disposed = true
        },
      }),
      judge: {
        async run() {
          throw new Error('judge should not run')
        },
      },
    })

    expect(result.status).toBe('timeout')
    expect(generatorClosed).toBe(true)
    expect(interrupted).toBe(true)
    expect(disposed).toBe(true)
  })

  test('does not hang forever when session dispose never resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-dispose-hang-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'dispose_hang_task', true)

    const result = await runSourceTaskLoop({
      taskId: 'dispose_hang_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 1,
      sessionDisposeGraceMs: 50,
      sessionFactory: async () => ({
        async *submit() {
          throw new Error('force dispose path')
        },
        async dispose() {
          await new Promise(() => {})
        },
      }),
      judge: {
        async run() {
          throw new Error('judge should not run')
        },
      },
    })

    expect(result.status).toBe('failed')
    const events = await readFile(join(result.run.logsDir, 'run_events.jsonl'), 'utf8')
    expect(events).toContain('session_dispose_timeout')
  })

  test('uses one source agent session across multiple judge feedback turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'demo_task', true)
    const prompts: string[] = []
    const startMaxTurns: Array<number | undefined> = []
    const turnMaxTurns: Array<number | undefined> = []
    const judgeRuntimePythons: string[] = []
    const sessionRuntimePythons: string[] = []
    let sessionCreations = 0
    let disposed = false
    const session: SourceAgentSession = {
      async *submit(input: SourceAgentTurnInput) {
        prompts.push(input.prompt)
        turnMaxTurns.push(input.maxTurnsPerRound)
        sessionRuntimePythons.push(input.runtime.python)
        yield { type: 'assistant_text', text: `turn ${prompts.length}` }
        yield {
          type: 'finalize',
          summary: 'ready',
          files: ['outputs/case_000.npz'],
        }
      },
      async dispose() {
        disposed = true
      },
    }
    const judge: JudgeRunner = {
      async run(input) {
        judgeRuntimePythons.push(input.runtime.python)
        return prompts.length < 3
          ? {
              status: 'fail',
              reward: 0,
              feedback: `missing final detail ${prompts.length}`,
              raw: { status: 'fail' },
            }
          : {
              status: 'pass',
              reward: 1,
              feedback: 'ok',
              raw: { status: 'pass' },
            }
      },
    }

    const result = await runSourceTaskLoop({
      taskId: 'demo_task',
      tasksDir,
      runsDir,
      maxRounds: 3,
      maxTurnsPerRound: 7,
      timeoutSeconds: 30,
      sessionFactory: async input => {
        sessionCreations++
        startMaxTurns.push(input.maxTurnsPerRound)
        return session
      },
      judge,
    })

    expect(result.status).toBe('success')
    expect(result.rounds).toBe(3)
    expect(sessionCreations).toBe(1)
    expect(startMaxTurns).toEqual([7])
    expect(turnMaxTurns).toEqual([7, 7, 7])
    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toContain('round_plan_file: workspace/plans/round_01.md')
    expect(prompts[0]).toContain('# Demo')
    expect(prompts[1]).toContain('<judge_feedback>')
    expect(prompts[1]).toContain('message: missing final detail 1')
    expect(prompts[1]).toContain('workspace/plans/round_02.md')
    expect(prompts[2]).toContain('message: missing final detail 2')
    expect(prompts[2]).toContain('workspace/plans/round_03.md')
    expect(new Set(sessionRuntimePythons).size).toBe(1)
    expect(judgeRuntimePythons).toEqual(sessionRuntimePythons)
    expect(disposed).toBe(true)
    expect(existsSync(join(result.run.logsDir, 'trajectory.clean.jsonl'))).toBe(true)
    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"judge_result"')
    expect(clean).not.toContain('result_path')
    expect(clean).not.toContain('.judge_private')
    expect(clean).not.toContain('"system_prompt"')
    const raw = await readFile(join(result.run.logsDir, 'trajectory.raw.jsonl'), 'utf8')
    expect(raw).toContain('"kind":"judge_result_raw"')
  })

  test('passes judge feedback level and snapshots outputs before judging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-judge-feedback-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'feedback_task', true)
    const feedbackLevels: Array<string | undefined> = []

    const result = await runSourceTaskLoop({
      taskId: 'feedback_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      judgeFeedbackLevel: 'metric_full',
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          await mkdir(input.taskRun.outputsDir, { recursive: true })
          await writeFile(join(input.taskRun.outputsDir, 'case_000.npz'), 'snapshot me', 'utf8')
          yield {
            type: 'submission_validation_passed',
            result: {
              ok: true,
              normalizedFiles: ['outputs/case_000.npz'],
              issues: [],
            },
          }
          yield { type: 'finalize', summary: 'ready', files: ['outputs/case_000.npz'] }
        },
      }),
      judge: {
        async run(input) {
          feedbackLevels.push(input.feedbackLevel)
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(feedbackLevels).toEqual(['metric_full'])
    expect(
      existsSync(join(result.run.logsDir, 'submissions', 'round_01', 'case_000.npz')),
    ).toBe(true)
  })

  test('writes run memory and reinjects active skills after failed judge round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-run-memory-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'memory_task', true)
    const prompts: string[] = []

    const result = await runSourceTaskLoop({
      taskId: 'memory_task',
      tasksDir,
      runsDir,
      maxRounds: 2,
      timeoutSeconds: 30,
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
      skillOptions: {
        enabled: true,
        mode: 'native',
        skillsDir: 'skills',
        allowedSkillNames: ['general-skill'],
      },
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          prompts.push(input.prompt)
          yield { type: 'tool_call', tool: 'Read', input: { file_path: 'public/README.md' } }
          yield { type: 'finalize', summary: 'ready', files: [] }
        },
      }),
      judge: {
        async run() {
          return prompts.length === 1
            ? {
                status: 'fail',
                reward: 0,
                feedback: 'nrmse too high',
                raw: {
                  cases: [
                    {
                      metrics: [{ name: 'nrmse', status: 'fail' }],
                    },
                  ],
                },
              }
            : {
                status: 'pass',
                reward: 1,
                feedback: 'ok',
                raw: { status: 'pass' },
              }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('<run_memory>')
    expect(prompts[1]).toContain('workspace/agent_memory.md')
    expect(prompts[1]).toContain('<active_skills>')
    expect(prompts[1]).toContain('general-skill')
    expect(existsSync(join(result.run.workspaceDir, 'agent_memory.md'))).toBe(true)
    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"context_event"')
    expect(clean).toContain('"subtype":"run_memory_written"')
  })

  test('loads resume context into initial prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-resume-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'resume_task', true)
    const resumeDir = join(runsDir, 'resume_task_old')
    await mkdir(join(resumeDir, 'workspace'), { recursive: true })
    await mkdir(join(resumeDir, 'logs'), { recursive: true })
    await writeFile(
      join(resumeDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'resume_task', run_id: 'resume_task_old' }),
      'utf8',
    )
    await writeFile(join(resumeDir, 'workspace', 'plan.md'), '# Old plan', 'utf8')
    await writeFile(join(resumeDir, 'workspace', 'agent_memory.md'), '# Old memory', 'utf8')
    await writeFile(
      join(resumeDir, 'logs', 'trajectory.clean.jsonl'),
      JSON.stringify({ kind: 'context_event', round: 1, subtype: 'compact_boundary', message: 'compacted' }),
      'utf8',
    )
    const prompts: string[] = []

    const result = await runSourceTaskLoop({
      taskId: 'resume_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        resumeRun: resumeDir,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          prompts.push(input.prompt)
          yield { type: 'finalize', summary: 'ready', files: [] }
        },
      }),
      judge: {
        async run() {
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(prompts[0]).toContain('<resume_context>')
    expect(prompts[0]).toContain('Old plan')
    expect(prompts[0]).toContain('Old memory')
    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"subtype":"resume_loaded"')
  })

  test('rejects resume context from a different task before creating a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-resume-cross-task-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'current_task', true)
    const resumeDir = join(runsDir, 'old_task_run')
    await mkdir(join(resumeDir, 'workspace'), { recursive: true })
    await mkdir(join(resumeDir, 'logs'), { recursive: true })
    await writeFile(
      join(resumeDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'old_task', run_id: 'old_task_run' }),
      'utf8',
    )
    let sessionCreations = 0

    await expect(
      runSourceTaskLoop({
        taskId: 'current_task',
        tasksDir,
        runsDir,
        maxRounds: 1,
        timeoutSeconds: 30,
        contextOptions: {
          profile: 'eval-safe-claude-parity',
          networkPolicy: 'disabled',
          runMemory: true,
          resumeRun: resumeDir,
          recordContextEvents: true,
          reInjectActiveSkillsEachRound: true,
          includeClaudeDefaultUserContext: false,
          enableSlashCommands: false,
          enableMcpClients: false,
          enableAgentTool: false,
        },
        sessionFactory: async () => {
          sessionCreations++
          throw new Error('should not create session for cross-task resume')
        },
        judge: {
          async run() {
            throw new Error('judge should not run')
          },
        },
      }),
    ).rejects.toThrow('does not match current task')
    expect(sessionCreations).toBe(0)
  })

  test('passes known task materials into run setup and initial prompt summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-known-materials-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'usct_FWI', true)
    await makeTask(tasksDir, 'ultrasound_sos_tomography', true)
    await mkdir(join(tasksDir, 'ultrasound_sos_tomography', 'std_code'), {
      recursive: true,
    })
    await writeFile(
      join(tasksDir, 'ultrasound_sos_tomography', 'std_code', 'main.py'),
      'print("known")',
      'utf8',
    )
    const prompts: string[] = []

    const result = await runSourceTaskLoop({
      taskId: 'usct_FWI',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      knownTaskMaterials: {
        enabled: true,
        sourceTaskIds: ['ultrasound_sos_tomography'],
      },
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          prompts.push(input.prompt)
          yield { type: 'finalize', summary: 'ready', files: [] }
        },
      }),
      judge: {
        async run() {
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(
      existsSync(
        join(
          result.run.publicDir,
          'known_tasks',
          'ultrasound_sos_tomography',
          'README.md',
        ),
      ),
    ).toBe(true)
    expect(
      existsSync(
        join(
          result.run.publicDir,
          'known_tasks',
          'ultrasound_sos_tomography',
          'std_code',
          'main.py',
        ),
      ),
    ).toBe(true)
    expect(prompts[0]).toContain('<known_task_materials>')
    expect(prompts[0]).toContain('public/known_tasks/')

    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"initial_prompt_audit"')
    expect(clean).toContain('"expected_known_task_materials_block":true')
    expect(clean).toContain('"has_known_task_materials_block":true')
    expect(clean).toContain('"known_task_materials_block_allowed":true')

    const summary = JSON.parse(
      await readFile(join(result.run.logsDir, 'run_summary.json'), 'utf8'),
    )
    expect(summary.known_task_materials).toEqual({
      enabled: true,
      source_task_ids: ['ultrasound_sos_tomography'],
      deep_read: false,
    })
  })

  test('records known task deep-read prompt mode in trajectory and summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-known-materials-deep-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'usct_FWI', true)
    await makeTask(tasksDir, 'ultrasound_sos_tomography', true)
    await mkdir(join(tasksDir, 'ultrasound_sos_tomography', 'std_code'), {
      recursive: true,
    })
    await writeFile(
      join(tasksDir, 'ultrasound_sos_tomography', 'std_code', 'main.py'),
      'print("known")',
      'utf8',
    )
    const prompts: string[] = []

    const result = await runSourceTaskLoop({
      taskId: 'usct_FWI',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      knownTaskMaterials: {
        enabled: true,
        sourceTaskIds: ['ultrasound_sos_tomography'],
        deepRead: true,
      },
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          prompts.push(input.prompt)
          yield { type: 'finalize', summary: 'ready', files: [] }
        },
      }),
      judge: {
        async run() {
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(prompts[0]).toContain('workspace/known_task_materials_notes.md')

    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"known_task_materials_prompt_mode":"deep_read"')
    expect(clean).toContain('"known_task_materials_deep_read_requested":true')

    const summary = JSON.parse(
      await readFile(join(result.run.logsDir, 'run_summary.json'), 'utf8'),
    )
    expect(summary.known_task_materials).toEqual({
      enabled: true,
      source_task_ids: ['ultrasound_sos_tomography'],
      deep_read: true,
    })
  })

  test('returns infra_error before creating a session when runtime is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-infra-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'broken_runtime', false)
    await mkdir(join(tasksDir, 'broken_runtime', 'envs'), { recursive: true })
    await writeFile(
      join(tasksDir, 'broken_runtime', 'envs', 'env_manifest.json'),
      JSON.stringify({
        default_env: 'runtime',
        envs: {
          runtime: {
            python: {
              windows: 'envs/runtime/.venv/Scripts/python.exe',
              posix: 'envs/runtime/.venv/bin/python',
            },
          },
        },
      }),
      'utf8',
    )
    const manifestPath = join(tasksDir, 'broken_runtime', 'task_manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.public_bundle.push('envs/')
    manifest.entrypoints = { environment: 'envs/env_manifest.json' }
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
    let sessionCreations = 0

    const result = await runSourceTaskLoop({
      taskId: 'broken_runtime',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      sessionFactory: async () => {
        sessionCreations++
        throw new Error('should not create session')
      },
      judge: {
        async run() {
          throw new Error('judge should not run')
        },
      },
    })

    expect(result.status).toBe('infra_error')
    expect(sessionCreations).toBe(0)
    expect(result.lastJudgeResult).toBeUndefined()
  })

  test('does not impose a per-round turn cap unless explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-unlimited-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'unlimited_task', true)
    const startMaxTurns: Array<number | undefined> = []
    const turnMaxTurns: Array<number | undefined> = []

    const result = await runSourceTaskLoop({
      taskId: 'unlimited_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      sessionFactory: async input => {
        startMaxTurns.push(input.maxTurnsPerRound)
        return {
          async *submit(turnInput: SourceAgentTurnInput) {
            turnMaxTurns.push(turnInput.maxTurnsPerRound)
            yield { type: 'finalize', summary: 'ready', files: [] }
          },
        }
      },
      judge: {
        async run() {
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(startMaxTurns).toEqual([undefined])
    expect(turnMaxTurns).toEqual([undefined])
  })

  test('requests same-session recovery when an agent turn ends without finalize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-recovery-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'recovery_task', true)
    const prompts: string[] = []
    let sessionCreations = 0
    let judgeCalls = 0

    const result = await runSourceTaskLoop({
      taskId: 'recovery_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      sessionFactory: async () => {
        sessionCreations++
        return {
          async *submit(input: SourceAgentTurnInput) {
            prompts.push(input.prompt)
            if (prompts.length === 1) {
              yield {
                type: 'agent_result',
                subtype: 'success',
                stopReason: 'end_turn',
                durationMs: 10,
                usage: { input_tokens: 12, output_tokens: 3 },
              } as never
              return
            }
            yield { type: 'assistant_text', text: 'Recovering by submitting output.' }
            yield {
              type: 'finalize',
              summary: 'ready after recovery',
              files: ['outputs/case_000.npz'],
            }
          },
        }
      },
      judge: {
        async run() {
          judgeCalls++
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(result.rounds).toBe(1)
    expect(sessionCreations).toBe(1)
    expect(judgeCalls).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('<no_finalize_recovery>')
    expect(prompts[1]).toContain('call finalize_submission now')

    const events = await readFile(join(result.run.logsDir, 'run_events.jsonl'), 'utf8')
    expect(events).toContain('"type":"agent_recovery_started"')
    expect(events).toContain('"type":"agent_recovery_finished"')

    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"agent_result"')
    expect(clean).toContain('"stop_reason":"end_turn"')
    expect(clean).toContain('"kind":"recovery_started"')
    expect(clean).toContain('"kind":"recovery_finished"')
    expect(clean).toContain('"finalized":true')
    expect(clean).toContain('ready after recovery')
  })

  test('restarts with a fresh session and compact recovery prompt after prompt-too-long', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-prompt-too-long-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'prompt_too_long_task', true)
    const prompts: string[] = []
    const startUserPrompts: Array<string | undefined> = []
    let sessionCreations = 0
    let disposedSessions = 0
    let judgeCalls = 0

    const result = await runSourceTaskLoop({
      taskId: 'prompt_too_long_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      userPrompt: 'Use visual model checks only; do not compute GT-only image metrics.',
      sessionFactory: async input => {
        sessionCreations++
        const sessionId = sessionCreations
        startUserPrompts.push(input.userPrompt)
        return {
          async *submit(turnInput: SourceAgentTurnInput) {
            prompts.push(turnInput.prompt)
            if (sessionId === 1) {
              throw new Error('prompt is too long: context length exceeded')
            }
            yield { type: 'assistant_text', text: 'Recovered in a fresh session.' }
            yield {
              type: 'finalize',
              summary: 'ready after prompt-too-long recovery',
              files: ['outputs/case_000.npz'],
            }
          },
          async dispose() {
            disposedSessions++
          },
        }
      },
      judge: {
        async run() {
          judgeCalls++
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(sessionCreations).toBe(2)
    expect(disposedSessions).toBe(2)
    expect(judgeCalls).toBe(1)
    expect(startUserPrompts).toEqual([
      'Use visual model checks only; do not compute GT-only image metrics.',
      'Use visual model checks only; do not compute GT-only image metrics.',
    ])
    expect(prompts[0]).toContain('<user_prompt>')
    expect(prompts[1]).toContain('<prompt_too_long_recovery>')
    expect(prompts[1]).toContain('<user_prompt>')
    expect(prompts[1]).toContain('Use visual model checks only')
    expect(prompts[1]).toContain('Do not restart broad exploration')

    const events = await readFile(join(result.run.logsDir, 'run_events.jsonl'), 'utf8')
    expect(events).toContain('prompt_too_long_recovery_started')

    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"subtype":"prompt_too_long"')
  })

  test('does not judge or consume a round when validation never passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-validation-fail-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'validation_fail_task', true)
    let judgeCalls = 0

    const result = await runSourceTaskLoop({
      taskId: 'validation_fail_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      llmOptions: { temperature: 1, thinking: 'disabled' },
      sessionFactory: async () => ({
        async *submit(input: SourceAgentTurnInput) {
          if (input.prompt.includes('<no_finalize_recovery>')) return
          yield {
            type: 'run_warning',
            code: 'missing_round_plan',
            message: 'workspace/plans/round_01.md is missing.',
          }
          yield {
            type: 'submission_validation_failed',
            result: {
              ok: false,
              normalizedFiles: [],
              issues: [
                {
                  code: 'missing_output_file',
                  path: 'outputs/case_000.npz',
                  message: 'outputs/case_000.npz is missing',
                },
              ],
            },
          }
        },
      }),
      judge: {
        async run() {
          judgeCalls++
          throw new Error('judge should not run')
        },
      },
    })

    expect(result.status).toBe('failed')
    expect(result.rounds).toBe(0)
    expect(judgeCalls).toBe(0)

    const summary = JSON.parse(
      await readFile(join(result.run.logsDir, 'run_summary.json'), 'utf8'),
    )
    expect(summary.run_metadata.temperature_configured).toBe(1)
    expect(summary.run_metadata.temperature_sent).toBe(1)
    expect(summary.validation_attempts).toHaveLength(1)
    expect(summary.validation_attempts[0].ok).toBe(false)
    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0].code).toBe('missing_round_plan')

    const events = await readFile(join(result.run.logsDir, 'run_events.jsonl'), 'utf8')
    expect(events).toContain('"type":"submission_validation_failed"')
    expect(events).toContain('"type":"run_warning"')

    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"submission_validation_failed"')
    expect(clean).toContain('"kind":"trajectory_warning"')
  })

  test('invalid validation followed by valid finalize consumes one judge round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-validation-retry-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'validation_retry_task', true)
    let judgeCalls = 0

    const result = await runSourceTaskLoop({
      taskId: 'validation_retry_task',
      tasksDir,
      runsDir,
      maxRounds: 2,
      timeoutSeconds: 30,
      sessionFactory: async () => ({
        async *submit() {
          yield {
            type: 'submission_validation_failed',
            result: {
              ok: false,
              normalizedFiles: [],
              issues: [
                {
                  code: 'shape_mismatch',
                  path: 'outputs/case_000.npz',
                  key: 'reconstruction',
                  message: 'shape mismatch',
                },
              ],
            },
          }
          yield {
            type: 'submission_validation_passed',
            result: {
              ok: true,
              normalizedFiles: ['outputs/case_000.npz'],
              issues: [],
            },
          }
          yield {
            type: 'finalize',
            summary: 'ready after retry',
            files: ['outputs/case_000.npz'],
          }
        },
      }),
      judge: {
        async run() {
          judgeCalls++
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    expect(result.rounds).toBe(1)
    expect(judgeCalls).toBe(1)

    const summary = JSON.parse(
      await readFile(join(result.run.logsDir, 'run_summary.json'), 'utf8'),
    )
    expect(summary.validation_attempts.map((attempt: { ok: boolean }) => attempt.ok)).toEqual([
      false,
      true,
    ])
  })

  test('stops draining agent events immediately after finalize', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-loop-finalize-terminal-'))
    const tasksDir = join(root, 'tasks')
    const runsDir = join(root, 'runs')
    await makeTask(tasksDir, 'finalize_terminal_task', true)

    const result = await runSourceTaskLoop({
      taskId: 'finalize_terminal_task',
      tasksDir,
      runsDir,
      maxRounds: 1,
      timeoutSeconds: 30,
      sessionFactory: async () => ({
        async *submit() {
          yield {
            type: 'submission_validation_passed',
            result: {
              ok: true,
              normalizedFiles: ['outputs/case_000.npz'],
              issues: [],
            },
          }
          yield {
            type: 'finalize',
            summary: 'ready',
            files: ['outputs/case_000.npz'],
          }
          yield {
            type: 'assistant_text',
            text: 'BUG: this event should not be consumed after finalize.',
          }
        },
      }),
      judge: {
        async run() {
          return {
            status: 'pass',
            reward: 1,
            feedback: 'ok',
            raw: { status: 'pass' },
          }
        },
      },
    })

    expect(result.status).toBe('success')
    const clean = await readFile(join(result.run.logsDir, 'trajectory.clean.jsonl'), 'utf8')
    expect(clean).toContain('"kind":"finalize"')
    expect(clean).not.toContain('BUG: this event should not be consumed')
  })
})
