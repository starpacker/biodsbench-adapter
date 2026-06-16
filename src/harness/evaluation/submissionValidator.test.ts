import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { validateSubmission } from './submissionValidator.js'
import type { RuntimeInfo, TaskRun } from './types.js'

const runtime: RuntimeInfo = {
  python: process.env.PYTHON ?? 'python',
  displayPath: process.env.PYTHON ?? 'python',
  envName: 'runtime',
}

async function fakeTaskRun(schema: unknown, cases: unknown): Promise<TaskRun> {
  const runDir = await mkdtemp(join(tmpdir(), 'submission-validator-'))
  const publicDir = join(runDir, 'public')
  const outputsDir = join(runDir, 'outputs')
  await mkdir(join(publicDir, 'visible_data'), { recursive: true })
  await mkdir(outputsDir, { recursive: true })
  await writeFile(join(publicDir, 'output_schema.json'), JSON.stringify(schema), 'utf8')
  await writeFile(
    join(publicDir, 'visible_data', 'cases.json'),
    JSON.stringify(cases),
    'utf8',
  )
  return {
    taskId: 'demo',
    runId: 'demo_run',
    runDir,
    publicDir,
    workspaceDir: join(runDir, 'workspace'),
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

async function writeNpz(
  path: string,
  arrays: Record<string, { shape: number[]; dtype: string; fill?: number; nan?: boolean }>,
): Promise<void> {
  const script = `
import json
import numpy as np
import sys

payload = json.loads(sys.argv[1])
items = {}
for key, spec in payload["arrays"].items():
    array = np.full(spec["shape"], spec.get("fill", 1), dtype=np.dtype(spec["dtype"]))
    if spec.get("nan"):
        array.flat[0] = np.nan
    items[key] = array
np.savez(payload["path"], **items)
`
  const child = Bun.spawn(
    [runtime.python, '-c', script, JSON.stringify({ path, arrays })],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(await new Response(child.stderr).text())
  }
}

function demoSchema() {
  return {
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
  }
}

const demoCases = {
  version: 1,
  cases: [{ id: 'case_000', expected_output: 'outputs/case_000.npz' }],
}

describe('validateSubmission', () => {
  test('validates expected npz files from public schema and cases', async () => {
    const taskRun = await fakeTaskRun(demoSchema(), demoCases)
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'), {
      reconstruction: { shape: [1, 2], dtype: 'float32' },
    })

    const result = await validateSubmission({ taskRun, runtime, files: [] })

    expect(result.ok).toBe(true)
    expect(result.normalizedFiles).toEqual(['outputs/case_000.npz'])
    expect(result.issues).toEqual([])
  })

  test('reports npz key, shape, dtype, and finite validation issues', async () => {
    const taskRun = await fakeTaskRun(
      {
        ...demoSchema(),
        arrays: [
          { key: 'missing', required: true, shape: [1, 2], dtype: ['float32'] },
          { key: 'bad_shape', required: true, shape: [1, 2], dtype: ['float32'] },
          { key: 'bad_dtype', required: true, shape: [1, 2], dtype: ['float32'] },
          { key: 'bad_finite', required: true, shape: [1, 2], dtype: ['float32'] },
        ],
      },
      demoCases,
    )
    await writeNpz(join(taskRun.outputsDir, 'case_000.npz'), {
      bad_shape: { shape: [2], dtype: 'float32' },
      bad_dtype: { shape: [1, 2], dtype: 'int32' },
      bad_finite: { shape: [1, 2], dtype: 'float32', nan: true },
    })

    const result = await validateSubmission({ taskRun, runtime, files: [] })

    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual([
      'missing_array_key',
      'shape_mismatch',
      'dtype_mismatch',
      'non_finite_values',
    ])
  })

  test('reports missing files and traversal without crashing', async () => {
    const taskRun = await fakeTaskRun(demoSchema(), demoCases)

    const result = await validateSubmission({
      taskRun,
      runtime,
      files: ['../public/README.md'],
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('path_outside_outputs')
    expect(result.issues.map(issue => issue.code)).toContain('missing_output_file')
  })

  test('reports validator runtime failures as validation issues', async () => {
    const taskRun = await fakeTaskRun(demoSchema(), demoCases)
    await writeFile(join(taskRun.outputsDir, 'case_000.npz'), 'not an npz', 'utf8')

    const result = await validateSubmission({
      taskRun,
      runtime: { ...runtime, python: join(taskRun.runDir, 'missing-python') },
      files: [],
    })

    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('validator_runtime_failed')
  })
})
