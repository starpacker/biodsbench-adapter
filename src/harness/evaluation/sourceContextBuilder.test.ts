import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import {
  buildInitialSourcePrompt,
  buildJudgeFeedbackPrompt,
  buildNoFinalizeRecoveryPrompt,
  buildSourceSystemPrompt,
} from './sourceContextBuilder.js'
import type { JudgeResult, RuntimeInfo, TaskRun } from './types.js'

async function fakeTaskRun(): Promise<TaskRun> {
  const root = await mkdtemp(join(tmpdir(), 'source-context-'))
  const runDir = join(root, 'runs', 'demo_run')
  const publicDir = join(runDir, 'public')
  await mkdir(join(publicDir, 'visible_data', 'cases', 'case_000', 'input_data'), {
    recursive: true,
  })
  await mkdir(join(publicDir, 'envs'), { recursive: true })
  await writeFile(join(publicDir, 'README.md'), '# Demo Task\nSolve it.\n', 'utf8')
  await writeFile(
    join(publicDir, 'output_schema.json'),
    JSON.stringify({
      submission: { path_template: 'outputs/{case_id}.npz' },
      arrays: [
        {
          key: 'reconstruction',
          shape: [1, 128, 128],
          dtype: ['float32', 'float64'],
        },
      ],
      validation: { finite_only: true },
    }),
    'utf8',
  )
  await writeFile(
    join(publicDir, 'visible_data', 'cases.json'),
    JSON.stringify({
      cases: [
        {
          id: 'case_000',
          input_dir: 'cases/case_000/input_data',
          params: 'cases/case_000/params_data.json',
          expected_output: 'outputs/case_000.npz',
        },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(publicDir, 'visible_data', 'cases', 'case_000', 'input_data', 'raw_data.npz'),
    'fake npz',
    'utf8',
  )
  await writeFile(join(publicDir, 'envs', 'env_manifest.json'), '{}', 'utf8')
  return {
    taskId: 'demo_task',
    runId: 'demo_run',
    runDir,
    publicDir,
    workspaceDir: join(runDir, 'workspace'),
    outputsDir: join(runDir, 'outputs'),
    logsDir: join(runDir, 'logs'),
    judgeDir: join(root, 'runs', '.judge_private', 'demo_run'),
    taskDir: join(root, 'tasks', 'demo_task'),
    manifest: { version: 1, task_id: 'demo_task' },
  }
}

const runtime: RuntimeInfo = {
  python: '/runs/demo_run/public/envs/runtime/.venv-posix/bin/python',
  displayPath: 'public/envs/runtime/.venv-posix/bin/python',
  envName: 'runtime',
}

describe('sourceContextBuilder', () => {
  test('builds a lean system contract with artifact planning and no TodoWrite', () => {
    const prompt = buildSourceSystemPrompt()

    expect(prompt).toContain('source-native evaluation harness')
    expect(prompt).toContain('workspace/plans/round_NN.md')
    expect(prompt).toContain('workspace/plan.md')
    expect(prompt).toContain('submit the best available valid output')
    expect(prompt).toContain('workspace/experiments/')
    expect(prompt).toContain('Do not put long Python programs in Bash python -c')
    expect(prompt).toContain('Do not use TodoWrite')
    expect(prompt).not.toContain('Current working directory:')
  })

  test('inlines README and compact public context without absolute run path', async () => {
    const taskRun = await fakeTaskRun()
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
    })

    expect(prompt).toContain('<task_statement>')
    expect(prompt).toContain('# Demo Task')
    expect(prompt).toContain('<public_files>')
    expect(prompt).toContain('visible_data/cases/case_000/input_data/raw_data.npz')
    expect(prompt).toContain('<output_contract>')
    expect(prompt).toContain('reconstruction: shape [1,128,128], dtype float32|float64, finite')
    expect(prompt).toContain('round_plan_file: workspace/plans/round_01.md')
    expect(prompt).toContain('workspace/plan.md')
    expect(prompt).toContain('workspace/experiments/')
    expect(prompt).toContain('judge feedback is more valuable than private speculation')
    expect(prompt).toContain('raw keys, shapes, dtypes, finite status, and value ranges')
    expect(prompt).not.toContain(taskRun.runDir)
    expect(prompt).not.toContain('HARNESS_HINTS')
    expect(prompt).not.toContain('must read public/output_schema.json')
  })

  test('builds compact judge feedback with next round plan path', () => {
    const judgeResult: JudgeResult = {
      status: 'fail',
      reward: 0,
      feedback: 'raw feedback should not be needed when raw cases exist',
      raw: {
        status: 'fail',
        cases: [
          {
            status: 'fail',
            reason: 'metric_threshold_not_met',
            format: { status: 'pass' },
            metrics: [
              { name: 'ncc', status: 'pass' },
              { name: 'nrmse', status: 'fail' },
            ],
          },
        ],
      },
      resultPath: '/runs/.judge_private/demo/judge_result_round_1.json',
    }

    const prompt = buildJudgeFeedbackPrompt({
      round: 1,
      maxRounds: 5,
      judgeResult,
    })

    expect(prompt).toContain('<judge_feedback>')
    expect(prompt).toContain('round: 1/5')
    expect(prompt).toContain('failed_metrics:')
    expect(prompt).toContain('- nrmse')
    expect(prompt).toContain('passed_metrics:')
    expect(prompt).toContain('- ncc')
    expect(prompt).toContain('workspace/plans/round_02.md')
    expect(prompt).toContain('submit the best current output to the judge')
    expect(prompt).toContain('revalidate outputs against the same contract')
    expect(prompt).not.toContain('.judge_private')
    expect(prompt).not.toContain('raw feedback should not be needed')
  })

  test('builds no-finalize recovery prompt that forces same-round closure', () => {
    const prompt = buildNoFinalizeRecoveryPrompt({ round: 2, maxRounds: 5 })

    expect(prompt).toContain('<no_finalize_recovery>')
    expect(prompt).toContain('round: 2/5')
    expect(prompt).toContain('previous turn ended without finalize_submission')
    expect(prompt).toContain('call finalize_submission now')
    expect(prompt).toContain('Do not start new open-ended research')
    expect(prompt).toContain('missing or invalid')
    expect(prompt).not.toContain('schema-valid')
  })

  test('omits <prior_subtasks> when priorSubtasks is empty or undefined', async () => {
    const taskRun = await fakeTaskRun()
    const promptNone = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
    })
    expect(promptNone).not.toContain('<prior_subtasks>')

    const promptEmpty = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      priorSubtasks: [],
    })
    expect(promptEmpty).not.toContain('<prior_subtasks>')
  })

  test('injects <prior_subtasks> block with code, status, and feedback when supplied', async () => {
    const taskRun = await fakeTaskRun()
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      priorSubtasks: [
        {
          taskId: '25303977_0',
          taskIdx: 0,
          status: 'success',
          passed: true,
          description: 'Compute baseline counts from clinical.csv',
          generatedCode: "import pandas as pd\ndf = pd.read_csv('public/data/clinical.csv')\nprint(len(df))\n",
          judgeFeedback: 'status: pass, metrics all ok',
          notes: 'clinical.csv has 245 rows, key column is patient_id',
        },
        {
          taskId: '25303977_1',
          taskIdx: 1,
          status: 'failed',
          passed: false,
          description: 'Compute mean age by group',
          generatedCode: '# failed attempt referenced wrong column "ages"',
          judgeFeedback: 'failed_metrics: [mean_age]; reason: KeyError "ages" (correct: "age")',
        },
      ],
    })

    expect(prompt).toContain('<prior_subtasks>')
    expect(prompt).toContain('continuing a serial multi-sub-task study')
    expect(prompt).toContain('task_id: 25303977_0')
    expect(prompt).toContain('judge_passed: true')
    expect(prompt).toContain('<generated_code language="python">')
    expect(prompt).toContain("pd.read_csv('public/data/clinical.csv')")
    expect(prompt).toContain('clinical.csv has 245 rows')
    expect(prompt).toContain('task_id: 25303977_1')
    expect(prompt).toContain('judge_passed: false')
    expect(prompt).toContain('KeyError "ages"')
    expect(prompt).toContain('</prior_subtasks>')

    // Prior block must appear before the actual task statement so the model
    // reads context first.
    const priorIdx = prompt.indexOf('<prior_subtasks>')
    const taskIdx = prompt.indexOf('<task_statement>')
    expect(priorIdx).toBeGreaterThan(-1)
    expect(taskIdx).toBeGreaterThan(priorIdx)

    // Existing required content must still be present.
    expect(prompt).toContain('<output_contract>')
    expect(prompt).toContain('round_plan_file: workspace/plans/round_01.md')
  })

  test('truncates oversized prior generated_code to keep prompts bounded', async () => {
    const taskRun = await fakeTaskRun()
    const big = 'x'.repeat(20000)
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      priorSubtasks: [
        {
          taskId: '25303977_0',
          generatedCode: big,
        },
      ],
    })
    expect(prompt).toContain('<prior_subtasks>')
    expect(prompt).toContain('generated_code truncated')
    // The huge raw string must not appear in full.
    expect(prompt.length).toBeLessThan(big.length)
  })
})
