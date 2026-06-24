import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { writeRunMemory } from './runMemory.js'
import type { JudgeResult, TaskRun } from './types.js'

async function fakeTaskRun(): Promise<TaskRun> {
  const runDir = await mkdtemp(join(tmpdir(), 'run-memory-'))
  return {
    taskId: 'target_task',
    runId: 'target_task_20260601_010101',
    runDir,
    publicDir: join(runDir, 'public'),
    workspaceDir: join(runDir, 'workspace'),
    outputsDir: join(runDir, 'outputs'),
    logsDir: join(runDir, 'logs'),
    judgeDir: join(runDir, '..', '.judge_private', 'target_task_20260601_010101'),
    taskDir: join(runDir, '..', '..', 'tasks', 'target_task'),
    manifest: { version: 1, task_id: 'target_task' },
  }
}

describe('writeRunMemory', () => {
  test('writes run-local memory from clean trajectory and judge feedback', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const trajectoryPath = join(taskRun.logsDir, 'trajectory.clean.jsonl')
    await writeFile(
      trajectoryPath,
      [
        JSON.stringify({ kind: 'tool_call', round: 1, tool: 'Read', input: { file_path: 'public/README.md' } }),
        JSON.stringify({ kind: 'tool_call', round: 1, tool: 'Bash', input: { command: 'python workspace/solver.py' } }),
        JSON.stringify({ kind: 'context_event', round: 1, subtype: 'compact_boundary', message: 'compacted' }),
      ].join('\n'),
      'utf8',
    )
    const latestJudgeResult: JudgeResult = {
      status: 'fail',
      reward: 0,
      feedback: 'nrmse too high',
      raw: {
        cases: [
          {
            reason: 'metric_threshold_not_met',
            metrics: [{ name: 'nrmse', status: 'fail' }],
          },
        ],
      },
    }

    const snapshot = await writeRunMemory({
      taskRun,
      trajectoryPath,
      latestJudgeResult,
    })

    expect(snapshot.path).toBe(join(taskRun.workspaceDir, 'agent_memory.md'))
    expect(snapshot.content).toContain('target_task')
    expect(snapshot.content).toContain('public/README.md')
    expect(snapshot.content).toContain('nrmse')
    expect(snapshot.content).toContain('compact_boundary')
    const written = await readFile(snapshot.path, 'utf8')
    expect(written).toBe(snapshot.content)
  })

  test('carries active skill contract constraints into the next failed round', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const trajectoryPath = join(taskRun.logsDir, 'trajectory.clean.jsonl')
    await writeFile(
      trajectoryPath,
      JSON.stringify({ kind: 'tool_call', round: 1, tool: 'Skill', input: { name: 'runtime-budgeting' } }),
      'utf8',
    )

    const snapshot = await writeRunMemory({
      taskRun,
      trajectoryPath,
      latestJudgeResult: {
        status: 'fail',
        reward: 0,
        feedback: 'metric still failed',
        raw: {},
      },
    })

    expect(snapshot.content).toContain('re-read Skill')
    expect(snapshot.content).toContain('skill contract')
    expect(snapshot.content).toContain('cheap probe')
    expect(snapshot.content).toContain('Do not repeat long optimization')
  })

  test('filters forbidden private markers from memory content', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const trajectoryPath = join(taskRun.logsDir, 'trajectory.clean.jsonl')
    await writeFile(
      trajectoryPath,
      JSON.stringify({
        kind: 'tool_call',
        round: 1,
        tool: 'Read',
        input: { file_path: '.judge_private/ground_truth/answer.npz' },
      }),
      'utf8',
    )

    const snapshot = await writeRunMemory({
      taskRun,
      trajectoryPath,
      latestJudgeResult: {
        status: 'fail',
        reward: 0,
        feedback: 'see .judge_private ground_truth answer.npz',
        raw: {},
      },
    })

    expect(snapshot.content).not.toContain('.judge_private')
    expect(snapshot.content).not.toContain('ground_truth')
    expect(snapshot.content).not.toContain('answer.npz')
  })

  test('filters forbidden private markers case-insensitively', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(taskRun.logsDir, { recursive: true })
    const trajectoryPath = join(taskRun.logsDir, 'trajectory.clean.jsonl')
    await writeFile(
      trajectoryPath,
      JSON.stringify({
        kind: 'context_event',
        round: 1,
        subtype: 'note',
        message: 'Do not expose .JUDGE_PRIVATE Ground_Truth answer.NPZ',
      }),
      'utf8',
    )

    const snapshot = await writeRunMemory({
      taskRun,
      trajectoryPath,
      latestJudgeResult: {
        status: 'fail',
        reward: 0,
        feedback: 'See REFERENCE_OUTPUTS and STD_CODE for the answer.',
        raw: {},
      },
    })

    expect(snapshot.content.toLowerCase()).not.toContain('.judge_private')
    expect(snapshot.content.toLowerCase()).not.toContain('ground_truth')
    expect(snapshot.content.toLowerCase()).not.toContain('answer.npz')
    expect(snapshot.content.toLowerCase()).not.toContain('reference_outputs')
    expect(snapshot.content.toLowerCase()).not.toContain('std_code')
    expect(snapshot.content).toContain('[redacted]')
  })
})
