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
