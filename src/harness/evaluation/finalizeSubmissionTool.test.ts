import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { createFinalizeSubmissionTool } from './finalizeSubmissionTool.js'
import type { RuntimeInfo, TaskRun } from './types.js'

const runtime: RuntimeInfo = {
  python: process.env.PYTHON ?? 'python',
  displayPath: process.env.PYTHON ?? 'python',
  envName: 'runtime',
}

async function fakeTaskRun(): Promise<TaskRun> {
  const runDir = await mkdtemp(join(tmpdir(), 'finalize-tool-'))
  const outputsDir = join(runDir, 'outputs')
  const workspaceDir = join(runDir, 'workspace')
  const publicDir = join(runDir, 'public')
  await mkdir(outputsDir, { recursive: true })
  await mkdir(join(workspaceDir, 'plans'), { recursive: true })
  await mkdir(join(publicDir, 'visible_data'), { recursive: true })
  await writeFile(
    join(publicDir, 'output_schema.json'),
    JSON.stringify({
      version: 1,
      format: 'npz',
      path_template: 'outputs/{case_id}.npz',
      arrays: [
        {
          key: 'reconstruction',
          required: true,
          shape: [1, 2],
          dtype: ['float32', 'float64'],
        },
      ],
      validation: { finite_only: true, allow_cast: false },
    }),
    'utf8',
  )
  await writeFile(
    join(publicDir, 'visible_data', 'cases.json'),
    JSON.stringify({
      version: 1,
      cases: [{ id: 'case_000', expected_output: 'outputs/case_000.npz' }],
    }),
    'utf8',
  )
  return {
    taskId: 'demo',
    runId: 'demo_run',
    runDir,
    publicDir,
    workspaceDir,
    outputsDir,
    logsDir: join(runDir, 'logs'),
    judgeDir: join(runDir, '..', '.judge_private', 'demo_run'),
    taskDir: join(runDir, '..', '..', 'tasks', 'demo'),
    manifest: {
      version: 1,
      task_id: 'demo',
      entrypoints: {
        output_schema: 'output_schema.json',
        cases: 'visible_data/cases.json',
      },
      submission: { output_dir: 'outputs', path_template: 'outputs/{case_id}.npz' },
    },
  }
}

async function writePlanArtifacts(taskRun: TaskRun): Promise<void> {
  await writeFile(join(taskRun.workspaceDir, 'plan.md'), '# Current plan\n', 'utf8')
  await writeFile(
    join(taskRun.workspaceDir, 'plans', 'round_01.md'),
    '# Round 01 Plan\n',
    'utf8',
  )
}

async function writeNpz(path: string, options: { includeKey?: boolean } = {}): Promise<void> {
  const script = `
import json
import numpy as np
import sys

payload = json.loads(sys.argv[1])
arrays = {}
if payload.get("includeKey", True):
    arrays["reconstruction"] = np.ones((1, 2), dtype=np.float32)
np.savez(payload["path"], **arrays)
`
  const child = Bun.spawn(
    [runtime.python, '-c', script, JSON.stringify({ path, ...options })],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(await new Response(child.stderr).text())
  }
}

describe('createFinalizeSubmissionTool', () => {
  test('marks schema-valid outputs ready and records missing plan warnings', async () => {
    const taskRun = await fakeTaskRun()
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'))
    const state = { readyForJudge: false as boolean, summary: '', files: [] as string[] }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    const result = await tool.call(
      { summary: 'ready', files: ['outputs/case_000.npz'] },
      {} as never,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )
    const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tooluse_123')

    expect(state.readyForJudge).toBe(true)
    expect(state.files).toEqual(['outputs/case_000.npz'])
    expect(state.warnings?.map(warning => warning.code)).toEqual([
      'missing_current_plan',
      'missing_round_plan',
    ])
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('tooluse_123')
    expect(block.content).toContain('Submission finalized: ready')
    expect(block.content).toContain('Warning: workspace/plan.md is missing')
  })

  test('rejects traversal outside outputs', async () => {
    const taskRun = await fakeTaskRun()
    await writePlanArtifacts(taskRun)
    const state = { readyForJudge: false as boolean, summary: '', files: [] as string[] }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    await expect(
      tool.call(
        { summary: 'bad', files: ['../public/README.md'] },
        {} as never,
        async () => ({ behavior: 'allow' }),
        {} as never,
      ),
    ).rejects.toThrow('outputs')
    expect(state.readyForJudge).toBe(false)
  })

  test('returns recoverable feedback when submission validation fails', async () => {
    const taskRun = await fakeTaskRun()
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'), { includeKey: false })
    const state = { readyForJudge: false as boolean, summary: '', files: [] as string[] }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    const result = await tool.call(
      { summary: 'bad output', files: ['outputs/case_000.npz'] },
      {} as never,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )

    expect(state.readyForJudge).toBe(false)
    expect(result.data).toContain('finalize_submission validation failed')
    expect(result.data).toContain('missing required key reconstruction')
  })

  test('returns recoverable feedback when an explicit output file is missing', async () => {
    const taskRun = await fakeTaskRun()
    const state = { readyForJudge: false as boolean, summary: '', files: [] as string[] }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    const result = await tool.call(
      { summary: 'missing file', files: ['outputs/case_000.npz'] },
      {} as never,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )

    expect(state.readyForJudge).toBe(false)
    expect(result.data).toContain('missing output file outputs/case_000.npz')
  })

  test('treats missing required round plan as a warning', async () => {
    const taskRun = await fakeTaskRun()
    await writePlanArtifacts(taskRun)
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'))
    const state = {
      readyForJudge: false as boolean,
      summary: '',
      files: [] as string[],
      requiredRoundPlan: 'workspace/plans/round_02.md',
    }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    await tool.call(
      { summary: 'missing round 2 plan', files: ['outputs/case_000.npz'] },
      {} as never,
      async () => ({ behavior: 'allow' }),
      {} as never,
    )

    expect(state.readyForJudge).toBe(true)
    expect(state.warnings?.map(warning => warning.code)).toContain('missing_round_plan')
  })

  test('rejects invalid required round plan paths', async () => {
    const taskRun = await fakeTaskRun()
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'))
    const state = {
      readyForJudge: false as boolean,
      summary: '',
      files: [] as string[],
      requiredRoundPlan: 'workspace/../public/plan.md',
    }
    const tool = createFinalizeSubmissionTool({ taskRun, state, runtime })

    await expect(
      tool.call(
        { summary: 'invalid round path', files: ['outputs/case_000.npz'] },
        {} as never,
        async () => ({ behavior: 'allow' }),
        {} as never,
      ),
    ).rejects.toThrow('invalid required plan path')
  })
})
