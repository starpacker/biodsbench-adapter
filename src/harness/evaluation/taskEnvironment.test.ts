import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { lstat, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskRun } from './taskEnvironment.js'

async function makeTaskPrototype(root: string, taskId: string): Promise<string> {
  const taskDir = join(root, taskId)
  await mkdir(join(taskDir, 'visible_data'), { recursive: true })
  await mkdir(join(taskDir, 'visible_data', 'cases', 'case_000', 'input_data'), {
    recursive: true,
  })
  await mkdir(join(taskDir, 'evaluation', 'data'), { recursive: true })
  await mkdir(join(taskDir, 'std_code'), { recursive: true })
  await mkdir(join(taskDir, 'envs'), { recursive: true })

  writeFileSync(join(taskDir, 'README.md'), 'public readme')
  writeFileSync(join(taskDir, 'requirements.txt'), '')
  writeFileSync(join(taskDir, 'output_schema.json'), '{"version":1}')
  writeFileSync(join(taskDir, 'visible_data', 'cases.json'), '{"cases":[]}')
  writeFileSync(
    join(taskDir, 'visible_data', 'cases', 'case_000', 'input_data', 'positions.npy'),
    'public positions',
  )
  writeFileSync(join(taskDir, 'evaluation', 'judge.py'), 'hidden judge')
  writeFileSync(join(taskDir, 'std_code', 'main.py'), 'hidden solution')
  writeFileSync(
    join(taskDir, 'task_manifest.json'),
    JSON.stringify({
      version: 1,
      task_id: taskId,
      public_bundle: [
        'README.md',
        'requirements.txt',
        'output_schema.json',
        'visible_data/',
        'envs/',
      ],
      private_judge_bundle: ['evaluation/'],
      entrypoints: {
        judge: 'evaluation/judge.py',
        cases: 'visible_data/cases.json',
        output_schema: 'output_schema.json',
        metrics: 'evaluation/metrics.json',
        environment: 'envs/env_manifest.json',
      },
    }),
  )
  return taskDir
}

describe('createTaskRun', () => {
  test('instantiates public workspace without exposing evaluation or std_code', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'task-env-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const runsDir = join(temp, 'runs')
      await makeTaskPrototype(tasksDir, 'demo_task')

      const run = await createTaskRun({
        taskId: 'demo_task',
        tasksDir,
        runsDir,
        timestamp: '20260511_010203',
      })

      expect(existsSync(join(run.publicDir, 'README.md'))).toBe(true)
      expect(existsSync(join(run.publicDir, 'visible_data', 'cases.json'))).toBe(
        true,
      )
      expect(existsSync(join(run.runDir, 'workspace'))).toBe(true)
      expect(existsSync(join(run.runDir, 'workspace', 'plans'))).toBe(true)
      expect(existsSync(join(run.runDir, 'workspace', 'experiments'))).toBe(true)
      expect(existsSync(join(run.runDir, 'outputs'))).toBe(true)
      expect(existsSync(join(run.runDir, 'logs', 'agent'))).toBe(true)
      expect(existsSync(join(run.runDir, 'judge'))).toBe(false)
      expect(existsSync(run.judgeDir)).toBe(true)
      expect(run.judgeDir.startsWith(run.runDir)).toBe(false)
      expect(existsSync(join(run.publicDir, 'evaluation'))).toBe(false)
      expect(existsSync(join(run.publicDir, 'std_code'))).toBe(false)
      expect(existsSync(join(run.publicDir, 'HARNESS_HINTS.md'))).toBe(false)

      const manifest = JSON.parse(
        readFileSync(join(run.runDir, 'run_manifest.json'), 'utf8'),
      )
      expect(manifest.task_id).toBe('demo_task')
      expect(manifest.public_dir).toBe('public')
      expect(manifest.workspace_dir).toBe('workspace')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('accepts UTF-8 BOM in task_manifest.json', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'task-env-bom-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const runsDir = join(temp, 'runs')
      await makeTaskPrototype(tasksDir, 'bom_task')

      const manifestPath = join(tasksDir, 'bom_task', 'task_manifest.json')
      const manifest = readFileSync(manifestPath, 'utf8')
      writeFileSync(manifestPath, `\ufeff${manifest}`, 'utf8')

      const run = await createTaskRun({
        taskId: 'bom_task',
        tasksDir,
        runsDir,
        timestamp: '20260511_040506',
      })

      expect(existsSync(join(run.publicDir, 'README.md'))).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('copies known task README and std_code into public known_tasks', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'task-env-known-materials-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const runsDir = join(temp, 'runs')
      await makeTaskPrototype(tasksDir, 'target')
      await makeTaskPrototype(tasksDir, 'source-a')
      await mkdir(join(tasksDir, 'source-a', 'std_code', 'src'), { recursive: true })
      writeFileSync(
        join(tasksDir, 'source-a', 'std_code', 'src', 'solvers.py'),
        'def solve(): pass',
      )

      const run = await createTaskRun({
        taskId: 'target',
        tasksDir,
        runsDir,
        timestamp: '20260511_111213',
        knownTaskMaterials: {
          enabled: true,
          sourceTaskIds: ['source-a'],
        },
      })

      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'README.md'))).toBe(true)
      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'std_code', 'main.py'))).toBe(true)
      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'std_code', 'src', 'solvers.py'))).toBe(true)
      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'output_schema.json'))).toBe(false)
      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'evaluation'))).toBe(false)
      expect(existsSync(join(run.publicDir, 'known_tasks', 'source-a', 'visible_data'))).toBe(false)

      const manifest = JSON.parse(
        readFileSync(join(run.runDir, 'run_manifest.json'), 'utf8'),
      )
      expect(manifest.known_task_materials).toEqual({
        enabled: true,
        copied: [
          {
            sourceTaskId: 'source-a',
            files: ['README.md', 'std_code/main.py', 'std_code/src/solvers.py'],
          },
        ],
        skipped: [],
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects reusing an existing run directory to avoid stale materials', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'task-env-reuse-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const runsDir = join(temp, 'runs')
      await makeTaskPrototype(tasksDir, 'target')
      await makeTaskPrototype(tasksDir, 'source-a')

      await createTaskRun({
        taskId: 'target',
        tasksDir,
        runsDir,
        timestamp: '20260511_222324',
        knownTaskMaterials: {
          enabled: true,
          sourceTaskIds: ['source-a'],
        },
      })

      await expect(
        createTaskRun({
          taskId: 'target',
          tasksDir,
          runsDir,
          timestamp: '20260511_222324',
          knownTaskMaterials: {
            enabled: false,
            sourceTaskIds: [],
          },
        }),
      ).rejects.toThrow('Run directory already exists')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('links host runtime venv instead of copying venv internals', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'task-env-runtime-link-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const runsDir = join(temp, 'runs')
      const taskDir = await makeTaskPrototype(tasksDir, 'runtime_link_task')
      const venvName = process.platform === 'win32' ? '.venv' : '.venv-posix'
      const pythonRel =
        process.platform === 'win32'
          ? 'envs/runtime/.venv/Scripts/python.exe'
          : 'envs/runtime/.venv-posix/bin/python'
      const pythonAbs = join(taskDir, ...pythonRel.split('/'))
      await mkdir(join(pythonAbs, '..'), { recursive: true })
      writeFileSync(pythonAbs, '')
      writeFileSync(
        join(taskDir, 'envs', 'env_manifest.json'),
        JSON.stringify({
          version: 1,
          default_env: 'runtime',
          envs: {
            runtime: {
              python: {
                [process.platform === 'win32' ? 'windows' : 'posix']: pythonRel,
              },
            },
          },
        }),
      )

      const run = await createTaskRun({
        taskId: 'runtime_link_task',
        tasksDir,
        runsDir,
        timestamp: '20260511_070809',
      })

      const linkedVenv = join(run.publicDir, 'envs', 'runtime', venvName)
      expect(existsSync(join(run.publicDir, ...pythonRel.split('/')))).toBe(true)
      expect((await lstat(linkedVenv)).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
