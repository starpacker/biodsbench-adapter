import { mkdir, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { createHarnessCanUseTool } from './harnessCanUseTool.js'
import type { TaskRun } from './types.js'

async function fakeTaskRun(): Promise<TaskRun> {
  const runDir = await mkdtemp(join(tmpdir(), 'harness-policy-'))
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

describe('createHarnessCanUseTool', () => {
  test('denies private reads, public writes, and package installation commands', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })
    const denyPrivate = await canUseTool(
      { name: 'Read' } as never,
      { file_path: join(taskRun.judgeDir, 'evaluation', 'judge.py') },
      {} as never,
      {} as never,
      'tool-1',
    )
    const denyPublicWrite = await canUseTool(
      { name: 'Write' } as never,
      { file_path: join(taskRun.publicDir, 'README.md'), content: 'x' },
      {} as never,
      {} as never,
      'tool-2',
    )
    const denyPip = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'python -m pip install numpy' },
      {} as never,
      {} as never,
      'tool-3',
    )

    expect(denyPrivate.behavior).toBe('deny')
    expect(denyPublicWrite.behavior).toBe('deny')
    expect(denyPip.behavior).toBe('deny')
  })

  test('allows workspace writes and output writes', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const workspaceWrite = await canUseTool(
      { name: 'Write' } as never,
      { file_path: join(taskRun.workspaceDir, 'solver.py'), content: 'print(1)' },
      {} as never,
      {} as never,
      'tool-1',
    )
    const outputWrite = await canUseTool(
      { name: 'Write' } as never,
      { file_path: join(taskRun.outputsDir, 'case_000.npz'), content: 'x' },
      {} as never,
      {} as never,
      'tool-2',
    )

    expect(workspaceWrite.behavior).toBe('allow')
    expect(outputWrite.behavior).toBe('allow')
  })

  test('denies bash writes that resolve under public after cd', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(join(taskRun.publicDir, 'visible_data', 'cases', 'case_000', 'input_data'), {
      recursive: true,
    })
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const readFromPublic = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cd public/visible_data/cases/case_000/input_data && python -c "print(1)"',
      },
      {} as never,
      {} as never,
      'tool-read',
    )
    const writeAfterPublicCd = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cd public/visible_data/cases/case_000/input_data && mkdir -p workspace/plans',
      },
      {} as never,
      {} as never,
      'tool-write',
    )
    const multilineWriteAfterPublicCd = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cd public/visible_data/cases/case_000/input_data\nmkdir -p workspace/plans',
      },
      {} as never,
      {} as never,
      'tool-multiline-write',
    )
    const writeExplicitPublic = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'echo x > public/visible_data/cases/case_000/input_data/leak.txt' },
      {} as never,
      {} as never,
      'tool-redirect',
    )
    const writeWorkspace = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'mkdir -p workspace/plans' },
      {} as never,
      {} as never,
      'tool-workspace',
    )

    expect(readFromPublic.behavior).toBe('allow')
    expect(writeAfterPublicCd.behavior).toBe('deny')
    expect(writeAfterPublicCd.message).toContain('public/')
    expect(multilineWriteAfterPublicCd.behavior).toBe('deny')
    expect(multilineWriteAfterPublicCd.message).toContain('public/')
    expect(writeExplicitPublic.behavior).toBe('deny')
    expect(writeWorkspace.behavior).toBe('allow')
  })
})
