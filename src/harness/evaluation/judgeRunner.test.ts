import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildJudgeArgs, resolveTaskPython } from './judgeRunner.js'
import type { TaskRun } from './types.js'

describe('resolveTaskPython', () => {
  test('uses env_manifest platform-specific python path', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'judge-python-'))
    try {
      const publicDir = join(temp, 'public')
      await mkdir(join(publicDir, 'envs', 'runtime', '.venv', 'Scripts'), {
        recursive: true,
      })
      await mkdir(join(publicDir, 'envs', 'runtime', '.venv', 'bin'), {
        recursive: true,
      })
      const windowsPython = join(
        publicDir,
        'envs',
        'runtime',
        '.venv',
        'Scripts',
        'python.exe',
      )
      const posixPython = join(
        publicDir,
        'envs',
        'runtime',
        '.venv',
        'bin',
        'python',
      )
      writeFileSync(windowsPython, '')
      writeFileSync(posixPython, '')
      writeFileSync(
        join(publicDir, 'envs', 'env_manifest.json'),
        JSON.stringify({
          version: 1,
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
      )

      const resolved = await resolveTaskPython(publicDir)
      expect(existsSync(resolved)).toBe(true)
      expect(resolved.endsWith(process.platform === 'win32' ? 'python.exe' : 'python')).toBe(
        true,
      )
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe('buildJudgeArgs', () => {
  function taskRun(root: string): TaskRun {
    return {
      taskId: 'demo_task',
      runId: 'demo_task_run',
      runDir: join(root, 'run'),
      judgeDir: join(root, 'run', '.judge_private'),
      publicDir: join(root, 'run', 'public'),
      workspaceDir: join(root, 'run', 'workspace'),
      outputsDir: join(root, 'run', 'outputs'),
      logsDir: join(root, 'run', 'logs'),
      taskDir: join(root, 'tasks', 'demo_task'),
      manifest: {
        version: 1,
        task_id: 'demo_task',
        entrypoints: {
          judge: 'evaluation/judge.py',
          cases: 'visible_data/cases.json',
          output_schema: 'output_schema.json',
          metrics: 'evaluation/metrics.json',
        },
      },
    }
  }

  test('defaults judge feedback level to metric_status', () => {
    const args = buildJudgeArgs({
      taskRun: taskRun('/tmp/eval'),
      round: 2,
    })

    expect(args).toContain('--feedback-level')
    expect(args[args.indexOf('--feedback-level') + 1]).toBe('metric_status')
  })

  test('allows metric_full judge feedback for diagnostic runs', () => {
    const args = buildJudgeArgs({
      taskRun: taskRun('/tmp/eval'),
      round: 2,
      feedbackLevel: 'metric_full',
    })

    expect(args[args.indexOf('--feedback-level') + 1]).toBe('metric_full')
  })
})
