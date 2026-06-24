import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertKnownTaskMaterialRequestSafe,
  copyKnownTaskMaterials,
  selectKnownTaskMaterialFiles,
} from './knownTaskMaterials.js'

describe('knownTaskMaterials', () => {
  test('selects only README, std_code main, and std_code src files for known task materials', () => {
    const selected = selectKnownTaskMaterialFiles([
      'README.md',
      'output_schema.json',
      'visible_data/cases.json',
      'std_code/main.py',
      'std_code/helper.py',
      'std_code/src/solvers.py',
      'std_code/src/nested/utils.py',
      'std_code/plan/approach.md',
      'std_code/notebooks/demo.ipynb',
      'std_code/__pycache__/main.cpython-314.pyc',
      'evaluation/judge.py',
      'envs/runtime/requirements.txt',
    ])

    expect(selected).toEqual([
      'README.md',
      'std_code/main.py',
      'std_code/src/nested/utils.py',
      'std_code/src/solvers.py',
    ])
  })

  test('rejects target task as a known task source', () => {
    expect(() =>
      assertKnownTaskMaterialRequestSafe({
        targetTaskId: 'usct_FWI',
        sourceTaskIds: ['usct_FWI'],
      }),
    ).toThrow('target task cannot be used as known task material')
    expect(() =>
      assertKnownTaskMaterialRequestSafe({
        targetTaskId: 'usct_FWI',
        sourceTaskIds: ['USCT_FWI'],
      }),
    ).toThrow('target task cannot be used as known task material')
  })

  test('rejects enabled known materials without source tasks', () => {
    expect(() =>
      assertKnownTaskMaterialRequestSafe({
        targetTaskId: 'usct_FWI',
        sourceTaskIds: [],
      }),
    ).toThrow('at least one known task source is required')
  })

  test('copies only README, std_code main, and std_code src into public known_tasks', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'known-task-materials-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const publicDir = join(temp, 'run', 'public')
      const sourceDir = join(tasksDir, 'source-a')
      await mkdir(join(tasksDir, 'target'), { recursive: true })
      await mkdir(join(sourceDir, 'std_code', 'src'), { recursive: true })
      await mkdir(join(sourceDir, 'std_code', 'plan'), { recursive: true })
      await mkdir(join(sourceDir, 'std_code', 'notebooks'), { recursive: true })
      await mkdir(join(sourceDir, 'std_code', '__pycache__'), { recursive: true })
      await mkdir(join(sourceDir, 'visible_data'), { recursive: true })
      await mkdir(join(sourceDir, 'evaluation'), { recursive: true })
      await mkdir(join(sourceDir, 'envs', 'runtime'), { recursive: true })
      writeFileSync(join(sourceDir, 'README.md'), '# Source A')
      writeFileSync(join(sourceDir, 'std_code', 'main.py'), 'print("ok")')
      writeFileSync(join(sourceDir, 'std_code', 'helper.py'), 'def helper(): pass')
      writeFileSync(join(sourceDir, 'std_code', 'src', 'solvers.py'), 'def solve(): pass')
      writeFileSync(join(sourceDir, 'std_code', 'plan', 'approach.md'), '# plan')
      writeFileSync(join(sourceDir, 'std_code', 'notebooks', 'demo.ipynb'), '{}')
      writeFileSync(join(sourceDir, 'std_code', '__pycache__', 'main.pyc'), 'cache')
      writeFileSync(join(sourceDir, 'output_schema.json'), '{}')
      writeFileSync(join(sourceDir, 'visible_data', 'cases.json'), '{}')
      writeFileSync(join(sourceDir, 'evaluation', 'judge.py'), '')
      writeFileSync(join(sourceDir, 'envs', 'runtime', 'requirements.txt'), '')

      const audit = await copyKnownTaskMaterials({
        targetTaskId: 'target',
        tasksDir,
        publicDir,
        options: {
          enabled: true,
          sourceTaskIds: ['source-a'],
        },
      })

      expect(audit.copied).toEqual([
        {
          sourceTaskId: 'source-a',
          files: ['README.md', 'std_code/main.py', 'std_code/src/solvers.py'],
        },
      ])
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'README.md'))).toBe(true)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', 'main.py'))).toBe(true)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', 'src', 'solvers.py'))).toBe(true)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', 'helper.py'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', 'plan'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', 'notebooks'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'output_schema.json'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'visible_data'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'evaluation'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'envs'))).toBe(false)
      expect(existsSync(join(publicDir, 'known_tasks', 'source-a', 'std_code', '__pycache__'))).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects a source directory whose manifest identifies the target task', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'known-task-materials-alias-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const publicDir = join(temp, 'run', 'public')
      const sourceDir = join(tasksDir, 'target-alias')
      await mkdir(join(tasksDir, 'target'), { recursive: true })
      await mkdir(join(sourceDir, 'std_code'), { recursive: true })
      writeFileSync(join(sourceDir, 'README.md'), '# Alias')
      writeFileSync(join(sourceDir, 'std_code', 'main.py'), 'print("target")')
      writeFileSync(
        join(sourceDir, 'task_manifest.json'),
        JSON.stringify({ version: 1, task_id: 'target' }),
      )

      await expect(
        copyKnownTaskMaterials({
          targetTaskId: 'target',
          tasksDir,
          publicDir,
          options: {
            enabled: true,
            sourceTaskIds: ['target-alias'],
          },
        }),
      ).rejects.toThrow('target task cannot be used as known task material')
      expect(existsSync(join(publicDir, 'known_tasks', 'target-alias'))).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects a known task source with no README or std_code files', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'known-task-materials-empty-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const publicDir = join(temp, 'run', 'public')
      await mkdir(join(tasksDir, 'target'), { recursive: true })
      await mkdir(join(tasksDir, 'source-empty'), { recursive: true })
      writeFileSync(join(tasksDir, 'source-empty', 'output_schema.json'), '{}')

      await expect(
        copyKnownTaskMaterials({
          targetTaskId: 'target',
          tasksDir,
          publicDir,
          options: {
            enabled: true,
            sourceTaskIds: ['source-empty'],
          },
        }),
      ).rejects.toThrow('has no README.md or std_code files')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
