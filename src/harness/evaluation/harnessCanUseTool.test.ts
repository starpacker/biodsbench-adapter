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
  test('denies Web and Agent tools when network policy is disabled', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun, networkPolicy: 'disabled' })

    for (const name of ['WebSearch', 'WebFetch', 'CompatWebSearch20250305', 'CompatWebFetchRead']) {
      const decision = await canUseTool(
        { name } as never,
        { query: 'latest paper' },
        {} as never,
        {} as never,
        `tool-${name}`,
      )
      expect(decision.behavior).toBe('deny')
      expect(decision.message).toContain('networkPolicy disabled')
    }

    const agent = await canUseTool(
      { name: 'Agent' } as never,
      { prompt: 'audit this' },
      {} as never,
      {} as never,
      'tool-agent',
    )
    expect(agent.behavior).toBe('deny')
    expect(agent.message).toContain('networkPolicy disabled')
  })

  test('allows Web tools when network policy is enabled', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun, networkPolicy: 'enabled' })

    const search = await canUseTool(
      { name: 'WebSearch' } as never,
      { query: 'docs' },
      {} as never,
      {} as never,
      'tool-web-enabled',
    )

    expect(search.behavior).toBe('allow')
  })

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
    const denyCurl = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'curl https://example.com' },
      {} as never,
      {} as never,
      'tool-4',
    )
    const denyWget = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'wget https://example.com/file' },
      {} as never,
      {} as never,
      'tool-5',
    )

    expect(denyPrivate.behavior).toBe('deny')
    expect(denyPublicWrite.behavior).toBe('deny')
    expect(denyPip.behavior).toBe('deny')
    expect(denyCurl.behavior).toBe('deny')
    expect(denyWget.behavior).toBe('deny')
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

  test('allows read-only access to explicitly active skill roots', async () => {
    const taskRun = await fakeTaskRun()
    const skillRoot = await mkdtemp(join(tmpdir(), 'active-skill-root-'))
    const otherSkillRoot = await mkdtemp(join(tmpdir(), 'inactive-skill-root-'))
    const shellSkillRoot = skillRoot.replace(/\\/g, '/')
    const canUseTool = createHarnessCanUseTool({
      taskRun,
      allowedReadRoots: [skillRoot],
    })

    const readSkillMd = await canUseTool(
      { name: 'Read' } as never,
      { file_path: join(skillRoot, 'SKILL.md') },
      {} as never,
      {} as never,
      'tool-read-active-skill',
    )
    const bashCatResource = await canUseTool(
      { name: 'Bash' } as never,
      { command: `cat ${shellSkillRoot}/resources/notes.md` },
      {} as never,
      {} as never,
      'tool-bash-active-resource',
    )
    const bashRunScript = await canUseTool(
      { name: 'Bash' } as never,
      { command: `python ${shellSkillRoot}/scripts/probe.py` },
      {} as never,
      {} as never,
      'tool-bash-active-script',
    )
    const writeSkillRoot = await canUseTool(
      { name: 'Write' } as never,
      { file_path: join(skillRoot, 'SKILL.md'), content: 'mutate' },
      {} as never,
      {} as never,
      'tool-write-active-skill',
    )
    const readInactiveSkill = await canUseTool(
      { name: 'Read' } as never,
      { file_path: join(otherSkillRoot, 'SKILL.md') },
      {} as never,
      {} as never,
      'tool-read-inactive-skill',
    )

    expect(readSkillMd.behavior).toBe('allow')
    expect(bashCatResource.behavior).toBe('allow')
    expect(bashRunScript.behavior).toBe('allow')
    expect(writeSkillRoot.behavior).toBe('deny')
    expect(readInactiveSkill.behavior).toBe('deny')
  })

  test('allows reading known task std_code under public known_tasks only', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const readKnownStdCode = await canUseTool(
      { name: 'Read' } as never,
      { file_path: 'public/known_tasks/source-a/std_code/main.py' },
      {} as never,
      {} as never,
      'tool-known-std-code',
    )
    const bashKnownStdCode = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cat public/known_tasks/source-a/std_code/main.py' },
      {} as never,
      {} as never,
      'tool-bash-known-std-code',
    )
    const bashRelativeKnownStdCode = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cd public/known_tasks/source-a && cat std_code/main.py' },
      {} as never,
      {} as never,
      'tool-bash-relative-known-std-code',
    )
    const bashTraversalStdCode = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cat public/known_tasks/source-a/std_code/../../../../tasks/demo/std_code/main.py',
      },
      {} as never,
      {} as never,
      'tool-bash-traversal-std-code',
    )
    const readPrivateStdCode = await canUseTool(
      { name: 'Read' } as never,
      { file_path: join(taskRun.taskDir, 'std_code', 'main.py') },
      {} as never,
      {} as never,
      'tool-private-std-code',
    )

    expect(readKnownStdCode.behavior).toBe('allow')
    expect(bashKnownStdCode.behavior).toBe('allow')
    expect(bashRelativeKnownStdCode.behavior).toBe('allow')
    expect(bashTraversalStdCode.behavior).toBe('deny')
    expect(readPrivateStdCode.behavior).toBe('deny')
  })

  test('allows logical Claude workspace absolute paths only inside run-local areas', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })
    const logicalRoot = '/Users/dev/workspace-22cc158a'

    const readPublicAbsolute = await canUseTool(
      { name: 'Read' } as never,
      { file_path: `${logicalRoot}/public/README.md` },
      {} as never,
      {} as never,
      'tool-read-logical-public',
    )
    const bashReadPublicAbsolute = await canUseTool(
      { name: 'Bash' } as never,
      { command: `cat ${logicalRoot}/public/README.md` },
      {} as never,
      {} as never,
      'tool-bash-read-logical-public',
    )
    const bashCdLogicalRoot = await canUseTool(
      { name: 'Bash' } as never,
      { command: `cd ${logicalRoot} && cat public/README.md` },
      {} as never,
      {} as never,
      'tool-bash-cd-logical-root',
    )
    const denyLogicalPrivate = await canUseTool(
      { name: 'Read' } as never,
      { file_path: `${logicalRoot}/../.judge_private/demo_run/evaluation/judge.py` },
      {} as never,
      {} as never,
      'tool-deny-logical-private',
    )

    expect(readPublicAbsolute.behavior).toBe('allow')
    expect(bashReadPublicAbsolute.behavior).toBe('allow')
    expect(bashCdLogicalRoot.behavior).toBe('allow')
    expect(denyLogicalPrivate.behavior).toBe('deny')
  })

  test('denies bash read escapes outside run-local paths', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const readSourceVisibleData = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cat ../../../../../tasks/ultrasound_sos_tomography/visible_data/cases.json',
      },
      {} as never,
      {} as never,
      'tool-read-source-visible',
    )
    const readSourceSchema = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'cat ../../../../../tasks/ultrasound_sos_tomography/output_schema.json',
      },
      {} as never,
      {} as never,
      'tool-read-source-schema',
    )
    const inlinePythonEscape = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          "python - <<'PY'\nopen('../../../../../tasks/ultrasound_sos_tomography/visible_data/cases.json').read()\nPY",
      },
      {} as never,
      {} as never,
      'tool-inline-python-escape',
    )
    const readPublicFromWorkspace = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cd workspace && cat ../public/README.md' },
      {} as never,
      {} as never,
      'tool-read-public-relative',
    )
    const readKnownStdCode = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cat public/known_tasks/source-a/std_code/main.py' },
      {} as never,
      {} as never,
      'tool-read-known-std-code',
    )

    expect(readSourceVisibleData.behavior).toBe('deny')
    expect(readSourceVisibleData.message).toContain('read target')
    expect(readSourceSchema.behavior).toBe('deny')
    expect(inlinePythonEscape.behavior).toBe('deny')
    expect(readPublicFromWorkspace.behavior).toBe('allow')
    expect(readKnownStdCode.behavior).toBe('allow')
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

  test('denies bash writes to harness logs root while allowing logs agent', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const writeLogsRoot = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cd workspace && timeout 1800 python run_fwi.py 2>&1 | tee ../logs/fwi_run.log' },
      {} as never,
      {} as never,
      'tool-logs-root',
    )
    const writeLogsAgent = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'cd workspace && timeout 1800 python run_fwi.py 2>&1 | tee ../logs/agent/fwi_run.log' },
      {} as never,
      {} as never,
      'tool-logs-agent',
    )

    expect(writeLogsRoot.behavior).toBe('deny')
    expect(writeLogsRoot.message).toContain('workspace/, outputs/, or logs/agent')
    expect(writeLogsAgent.behavior).toBe('allow')
  })

  test('allows standard stderr redirection without treating file descriptors as paths', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const stderrToStdout = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'timeout 60 python workspace/solver.py 2>&1 | head -100' },
      {} as never,
      {} as never,
      'tool-stderr-stdout',
    )
    const stderrToNull = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'python workspace/solver.py 2>/dev/null' },
      {} as never,
      {} as never,
      'tool-stderr-null',
    )
    const readCommandWithStderrToNull = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'sleep 60 && cat workspace/fwi_log.txt 2>/dev/null || echo "Log not ready yet"' },
      {} as never,
      {} as never,
      'tool-cat-stderr-null',
    )

    expect(stderrToStdout.behavior).toBe('allow')
    expect(stderrToNull.behavior).toBe('allow')
    expect(readCommandWithStderrToNull.behavior).toBe('allow')
  })

  test('allows inline python arithmetic and comments with slash-like text', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const cflCheck = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'python -c "v_max = 5500.0  # m/s\n' +
          'dx = 20.0\n' +
          'dt = 0.004\n' +
          'cfl = v_max * dt / dx\n' +
          'print(cfl)"',
      },
      {} as never,
      {} as never,
      'tool-cfl-check',
    )

    expect(cflCheck.behavior).toBe('allow')
  })

  test('allows background ampersand without treating it as a read path', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const backgroundPipeline = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'python workspace/solver.py 2>&1 | head -20 &\n' +
          'BG_PID=$!\n' +
          'sleep 1\n' +
          'kill $BG_PID 2>/dev/null',
      },
      {} as never,
      {} as never,
      'tool-background-ampersand',
    )

    expect(backgroundPipeline.behavior).toBe('allow')
  })

  test('denies unbounded background python processes that bypass validation timeouts', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const unboundedNohup = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'nohup python3 -u workspace/fwi_solver.py > logs/agent/fwi_run.log 2>&1 &',
      },
      {} as never,
      {} as never,
      'tool-unbounded-nohup',
    )
    const unboundedBackground = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'python3 -u workspace/fwi_solver.py > logs/agent/fwi_run.log 2>&1 &' },
      {} as never,
      {} as never,
      'tool-unbounded-background',
    )
    const boundedBackground = await canUseTool(
      { name: 'Bash' } as never,
      {
        command:
          'timeout 120 python3 -u workspace/fwi_solver.py > logs/agent/fwi_run.log 2>&1 &',
      },
      {} as never,
      {} as never,
      'tool-bounded-background',
    )

    expect(unboundedNohup.behavior).toBe('deny')
    expect(unboundedNohup.message).toContain('background')
    expect(unboundedBackground.behavior).toBe('deny')
    expect(unboundedBackground.message).toContain('background')
    expect(boundedBackground.behavior).toBe('allow')
  })

  test('allows grep process filters without treating the pattern as a file path', async () => {
    const taskRun = await fakeTaskRun()
    const canUseTool = createHarnessCanUseTool({ taskRun })

    const processFilter = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'ps aux | grep test_fwi_short.py | grep -v grep' },
      {} as never,
      {} as never,
      'tool-process-filter',
    )
    const grepPublicFile = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'grep Loss logs/agent/fwi_full_run.log' },
      {} as never,
      {} as never,
      'tool-grep-file',
    )
    const grepPrivateFile = await canUseTool(
      { name: 'Bash' } as never,
      { command: 'grep Loss ../../tasks/demo/std_code/main.py' },
      {} as never,
      {} as never,
      'tool-grep-private-file',
    )

    expect(processFilter.behavior).toBe('allow')
    expect(grepPublicFile.behavior).toBe('allow')
    expect(grepPrivateFile.behavior).toBe('deny')
  })

  test('denies long bash timeouts when a validation timeout cap is configured', async () => {
    const previous = process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
    process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS = '120000'
    try {
      const taskRun = await fakeTaskRun()
      const canUseTool = createHarnessCanUseTool({ taskRun })

      const longRun = await canUseTool(
        { name: 'Bash' } as never,
        { command: 'python workspace/solver.py', timeout: 600000 },
        {} as never,
        {} as never,
        'tool-long',
      )
      const cappedRun = await canUseTool(
        { name: 'Bash' } as never,
        { command: 'python workspace/solver.py', timeout: 120000 },
        {} as never,
        {} as never,
        'tool-capped',
      )
      const longShellTimeout = await canUseTool(
        { name: 'Bash' } as never,
        { command: 'timeout 360 python workspace/solver.py' },
        {} as never,
        {} as never,
        'tool-long-shell-timeout',
      )
      const cappedShellTimeout = await canUseTool(
        { name: 'Bash' } as never,
        { command: 'timeout 120 python workspace/solver.py' },
        {} as never,
        {} as never,
        'tool-capped-shell-timeout',
      )

      expect(longRun.behavior).toBe('deny')
      expect(longRun.message).toContain('timeout')
      expect(cappedRun.behavior).toBe('allow')
      expect(longShellTimeout.behavior).toBe('deny')
      expect(longShellTimeout.message).toContain('timeout')
      expect(cappedShellTimeout.behavior).toBe('allow')
    } finally {
      if (previous === undefined) delete process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
      else process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS = previous
    }
  })
})
