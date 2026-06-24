import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { loadResumeRunSnapshot } from './runResume.js'

describe('loadResumeRunSnapshot', () => {
  test('loads manifest, plan, memory, judge result, and context events', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'resume-run-'))
    await mkdir(join(runDir, 'workspace'), { recursive: true })
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await writeFile(
      join(runDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'target_task', run_id: 'target_task_1' }),
      'utf8',
    )
    await writeFile(join(runDir, 'workspace', 'plan.md'), '# Latest plan', 'utf8')
    await writeFile(join(runDir, 'workspace', 'agent_memory.md'), '# Run Memory', 'utf8')
    await writeFile(
      join(runDir, 'logs', 'trajectory.clean.jsonl'),
      [
        JSON.stringify({ kind: 'judge_result', round: 1, status: 'fail', reward: 0, feedback: { failedMetrics: ['nrmse'] } }),
        JSON.stringify({ kind: 'context_event', round: 1, subtype: 'compact_boundary', message: 'compacted' }),
      ].join('\n'),
      'utf8',
    )

    const snapshot = await loadResumeRunSnapshot(runDir)

    expect(snapshot.taskId).toBe('target_task')
    expect(snapshot.latestPlan).toContain('Latest plan')
    expect(snapshot.runMemory).toContain('Run Memory')
    expect(snapshot.latestJudgeResult?.status).toBe('fail')
    expect(snapshot.contextEvents).toEqual([
      { round: 1, subtype: 'compact_boundary', message: 'compacted' },
    ])
  })

  test('rejects private judge resume paths', async () => {
    await expect(loadResumeRunSnapshot(join(tmpdir(), '.judge_private', 'run'))).rejects.toThrow(
      'private judge',
    )
  })

  test('rejects resume directories outside the configured runs root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-root-'))
    const runsRoot = join(root, 'runs')
    const outside = join(root, 'outside', 'old_run')

    await expect(
      loadResumeRunSnapshot(outside, { runsRoot }),
    ).rejects.toThrow('outside run root')
  })

  test('rejects resume snapshots from a different task', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'resume-cross-task-'))
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await writeFile(
      join(runDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'old_task', run_id: 'old_task_1' }),
      'utf8',
    )

    await expect(
      loadResumeRunSnapshot(runDir, { expectedTaskId: 'new_task' }),
    ).rejects.toThrow('does not match current task')
  })

  test('sanitizes unsafe resume plan and memory text before prompt injection', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'resume-sanitize-'))
    await mkdir(join(runDir, 'workspace'), { recursive: true })
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await writeFile(
      join(runDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'target_task', run_id: 'target_task_1' }),
      'utf8',
    )
    await writeFile(
      join(runDir, 'workspace', 'plan.md'),
      'Read .judge_private/secret and ground_truth answer.npz',
      'utf8',
    )
    await writeFile(
      join(runDir, 'workspace', 'agent_memory.md'),
      'Compare against reference_outputs and std_code',
      'utf8',
    )

    const snapshot = await loadResumeRunSnapshot(runDir, { expectedTaskId: 'target_task' })

    expect(snapshot.latestPlan).not.toContain('.judge_private')
    expect(snapshot.latestPlan).not.toContain('ground_truth')
    expect(snapshot.latestPlan).not.toContain('answer.npz')
    expect(snapshot.runMemory).not.toContain('reference_outputs')
    expect(snapshot.runMemory).not.toContain('std_code')
    expect(snapshot.latestPlan).toContain('[redacted]')
    expect(snapshot.runMemory).toContain('[redacted]')
  })

  test('sanitizes unsafe resume text case-insensitively', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'resume-sanitize-case-'))
    await mkdir(join(runDir, 'workspace'), { recursive: true })
    await mkdir(join(runDir, 'logs'), { recursive: true })
    await writeFile(
      join(runDir, 'run_manifest.json'),
      JSON.stringify({ task_id: 'target_task', run_id: 'target_task_1' }),
      'utf8',
    )
    await writeFile(
      join(runDir, 'workspace', 'plan.md'),
      'Read .JUDGE_PRIVATE/secret and Ground_Truth answer.NPZ',
      'utf8',
    )
    await writeFile(
      join(runDir, 'workspace', 'agent_memory.md'),
      'Compare against REFERENCE_OUTPUTS and STD_CODE',
      'utf8',
    )

    const snapshot = await loadResumeRunSnapshot(runDir, { expectedTaskId: 'target_task' })

    expect(snapshot.latestPlan?.toLowerCase()).not.toContain('.judge_private')
    expect(snapshot.latestPlan?.toLowerCase()).not.toContain('ground_truth')
    expect(snapshot.latestPlan?.toLowerCase()).not.toContain('answer.npz')
    expect(snapshot.runMemory?.toLowerCase()).not.toContain('reference_outputs')
    expect(snapshot.runMemory?.toLowerCase()).not.toContain('std_code')
    expect(snapshot.latestPlan).toContain('[redacted]')
    expect(snapshot.runMemory).toContain('[redacted]')
  })
})
