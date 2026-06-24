import { mkdir, mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import {
  cleanAssistantTextForTrajectory,
  SourceTrajectoryWriter,
} from './sourceTrajectoryWriter.js'
import type { TaskRun } from './types.js'

async function fakeTaskRun(): Promise<TaskRun> {
  const runDir = await mkdtemp(join(tmpdir(), 'trajectory-writer-'))
  return {
    taskId: 'demo',
    runId: 'demo_run',
    runDir,
    publicDir: join(runDir, 'public'),
    workspaceDir: join(runDir, 'workspace'),
    outputsDir: join(runDir, 'outputs'),
    logsDir: join(runDir, 'logs'),
    judgeDir: join(runDir, '..', '.judge_private', 'demo_run'),
    taskDir: join(runDir, '..', '..', 'tasks', 'demo'),
    manifest: { version: 1, task_id: 'demo' },
  }
}

describe('SourceTrajectoryWriter', () => {
  test('filters standalone punctuation noise from clean assistant text only', async () => {
    expect(cleanAssistantTextForTrajectory('.')).toBeUndefined()
    expect(cleanAssistantTextForTrajectory('...')).toBeUndefined()
    expect(cleanAssistantTextForTrajectory('.\n\nNow I understand')).toBe(
      'Now I understand',
    )
    expect(cleanAssistantTextForTrajectory('This is fine.')).toBe('This is fine.')

    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const writer = new SourceTrajectoryWriter(taskRun)
    await writer.start({ startedAt: '2026-05-14T00:00:00.000Z' })
    await writer.agentEvent(1, { type: 'assistant_text', text: '.' })
    await writer.agentEvent(1, {
      type: 'assistant_text',
      text: '.\n\nNow I understand',
    })

    const raw = await readFile(writer.rawPath, 'utf8')
    expect(raw).toContain('"text":"."')
    const clean = await readFile(writer.cleanPath, 'utf8')
    expect(clean).not.toContain('"text":"."')
    expect(clean).toContain('"text":"Now I understand"')
  })

  test('writes trajectory warnings to clean trajectory', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const writer = new SourceTrajectoryWriter(taskRun)
    await writer.start({ startedAt: '2026-05-14T00:00:00.000Z' })

    await writer.agentEvent(1, {
      type: 'trajectory_warning',
      code: 'public_dir_mutation',
      message: 'Bash modified public/.',
      details: { paths: ['public/visible_data/cases/case_000/input_data/workspace'] },
    })

    const clean = await readFile(writer.cleanPath, 'utf8')
    expect(clean).toContain('"kind":"trajectory_warning"')
    expect(clean).toContain('"code":"public_dir_mutation"')
  })

  test('writes context events to clean and raw trajectories', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const writer = new SourceTrajectoryWriter(taskRun)
    await writer.start({ startedAt: '2026-05-14T00:00:00.000Z' })

    await writer.agentEvent(2, {
      type: 'context_event',
      subtype: 'compact_boundary',
      message: 'summary preserved',
      usage: { input_tokens: 1000 },
      metadata: { nested: 'value' },
    })

    const raw = await readFile(writer.rawPath, 'utf8')
    expect(raw).toContain('"type":"context_event"')
    const clean = await readFile(writer.cleanPath, 'utf8')
    expect(clean).toContain('"kind":"context_event"')
    expect(clean).toContain('"subtype":"compact_boundary"')
    expect(clean).toContain('"message":"summary preserved"')
  })

  test('writes structured validation and run warning events to clean trajectory', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const writer = new SourceTrajectoryWriter(taskRun)
    await writer.start({ startedAt: '2026-05-14T00:00:00.000Z' })

    await writer.agentEvent(1, {
      type: 'run_warning',
      code: 'missing_round_plan',
      message: 'workspace/plans/round_01.md is missing.',
    })
    await writer.agentEvent(1, {
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
    })
    await writer.agentEvent(1, {
      type: 'submission_validation_passed',
      result: {
        ok: true,
        normalizedFiles: ['outputs/case_000.npz'],
        issues: [],
      },
    })

    const clean = await readFile(writer.cleanPath, 'utf8')
    expect(clean).toContain('"kind":"trajectory_warning"')
    expect(clean).toContain('"kind":"submission_validation_failed"')
    expect(clean).toContain('"kind":"submission_validation_passed"')
    expect(clean).toContain('"normalized_files":["outputs/case_000.npz"]')
  })
})
