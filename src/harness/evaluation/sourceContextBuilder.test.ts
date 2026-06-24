import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
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
  test('builds a lean system contract with artifact planning and TodoWrite scratchpad', () => {
    const prompt = buildSourceSystemPrompt()

    expect(prompt).toContain('source-native evaluation harness')
    expect(prompt).toContain('workspace/plans/round_NN.md')
    expect(prompt).toContain('workspace/plan.md')
    expect(prompt).toContain('submit the best available valid output')
    expect(prompt).toContain('workspace/experiments/')
    expect(prompt).toContain('Do not put long Python programs in Bash python -c')
    expect(prompt).toContain('python -u')
    expect(prompt).toContain('do not launch duplicate long-running processes')
    expect(prompt).toContain('do not replace them with TodoWrite items')
    expect(prompt).toContain('TodoWrite as scratchpad')
    expect(prompt).not.toContain('Coordinator/subagent discipline')
    expect(prompt).not.toContain('Agent subagents')
    expect(prompt).not.toContain('Subagent delegation plan')
    expect(prompt).not.toContain('Network access is disabled')
    expect(prompt).not.toContain('GPU-first Torch discipline')
    expect(prompt).not.toContain('Anti-overoptimization discipline')
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
    expect(prompt).toContain('Treat public README/case params/metadata as authoritative')
    expect(prompt).toContain('do not reuse older defaults from memory, skills, or prior runs')
    expect(prompt).toContain('record the public parameter source, planned count, observed per-iteration time')
    expect(prompt).not.toContain('objective/formula/convention audit')
    expect(prompt).not.toContain('network_policy:')
    expect(prompt).not.toContain('local-only audit')
    expect(prompt).not.toContain('Subagent delegation plan')
    expect(prompt).not.toContain('Agent tool is available')
    expect(prompt).not.toContain('step size, preconditioner, smoothing')
    expect(prompt).not.toContain(taskRun.runDir)
    expect(prompt).not.toContain('HARNESS_HINTS')
    expect(prompt).not.toContain('must read public/output_schema.json')
  })

  test('injects dynamic user prompt into user messages, not system prompt', async () => {
    const taskRun = await fakeTaskRun()
    const userPrompt = [
      'Task-specific constraints:',
      '- Use the Agent tool only for bounded audits.',
      '- Vision checks are allowed, but no GT-only image metrics.',
    ].join('\n')

    const initial = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      hasKnownTaskMaterials: true,
      userPrompt,
    })
    const judge = buildJudgeFeedbackPrompt({
      round: 1,
      maxRounds: 5,
      judgeResult: {
        status: 'fail',
        reward: 0,
        feedback: 'needs a focused fix',
        raw: {},
      },
      userPrompt,
    })

    expect(initial).toContain('<user_prompt>')
    expect(initial).toContain('Task-specific constraints:')
    expect(initial).toContain('Vision checks are allowed')
    expect(initial.indexOf('</visible_cases>')).toBeLessThan(
      initial.indexOf('<user_prompt>'),
    )
    expect(initial.indexOf('<user_prompt>')).toBeLessThan(
      initial.indexOf('<known_task_materials>'),
    )
    expect(judge).toContain('<user_prompt>')
    expect(judge).toContain('Task-specific constraints:')
    expect(buildSourceSystemPrompt()).not.toContain('Task-specific constraints:')
  })

  test('usct FWI recovery user prompt requires README-compliant CBS FWI', async () => {
    const prompt = await readFile(
      'config/prompts/usct-fwi-known-ab-user-prompt-v2.md',
      'utf8',
    )

    expect(prompt).toContain('README.md is the highest-priority task specification')
    expect(prompt).toContain('frequency-domain Full-Waveform Inversion with a Convergent Born Series')
    expect(prompt).toContain('Do not submit amplitude backprojection')
    expect(prompt).toContain('straight-ray travel-time tomography')
    expect(prompt).toContain('phase-only LSQR')
    expect(prompt).toContain('NCC is not a success signal')
    expect(prompt).toContain('Do not call `finalize_submission`')
    expect(prompt).toContain('README compliance checklist')
    expect(prompt).toContain('Use the POSIX Torch runtime through `python` from PATH')
    expect(prompt).toContain('run a CUDA probe')
    expect(prompt).toContain('prefer CUDA for Torch tensors')
    expect(prompt).toContain('device = torch.device("cuda" if torch.cuda.is_available() else "cpu")')
    expect(prompt).not.toContain('If full CBS/FWI is too slow or unstable')
  })

  test('mentions known task materials only when configured', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(join(taskRun.publicDir, 'known_tasks', 'source-a', 'std_code'), {
      recursive: true,
    })
    await writeFile(
      join(taskRun.publicDir, 'known_tasks', 'source-a', 'README.md'),
      '# Source A',
      'utf8',
    )
    await writeFile(
      join(taskRun.publicDir, 'known_tasks', 'source-a', 'std_code', 'main.py'),
      'print("known")',
      'utf8',
    )
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      hasKnownTaskMaterials: true,
    })

    const knownBlock = prompt.match(
      /<known_task_materials>[\s\S]*<\/known_task_materials>/,
    )?.[0]
    expect(knownBlock).toContain('<known_task_materials>')
    expect(knownBlock).toContain('public/known_tasks/')
    expect(prompt).not.toContain('known_tasks/source-a/README.md')
    expect(prompt).not.toContain('known_tasks/source-a/std_code/main.py')
    expect(knownBlock).not.toContain('README.md')
    expect(knownBlock).not.toContain('std_code')
    expect(knownBlock).not.toContain('prior')
    expect(knownBlock).not.toContain('source task')
    expect(knownBlock).not.toContain('transfer')
    expect(knownBlock).not.toContain('hypothesis')
    expect(knownBlock).not.toContain('ultrasound_sos_tomography helps')

    const baselinePrompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
    })
    expect(baselinePrompt).not.toContain('<known_task_materials>')
  })

  test('asks the source agent to inspect active skills only when configured', async () => {
    const taskRun = await fakeTaskRun()
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      hasActiveSkills: true,
      activeSkillNames: ['wave-inversion-checks', 'runtime-budgeting'],
    })

    const skillBlock = prompt.match(/<active_skills>[\s\S]*<\/active_skills>/)?.[0]
    expect(skillBlock).toContain('Skill tool is enabled')
    expect(skillBlock).toContain('call the Skill tool')
    expect(skillBlock).toContain('Applied skills checklist')
    expect(skillBlock).toContain('workspace/skill_application.json')
    expect(skillBlock).toContain('used, not_applicable, or blocked_but_overridden')
    expect(skillBlock).toContain('cheap probe')
    expect(skillBlock).toContain('stop condition')
    expect(skillBlock).toContain('wave-inversion-checks')
    expect(skillBlock).toContain('runtime-budgeting')
    expect(skillBlock).not.toContain('known_tasks')
    expect(skillBlock).not.toContain('std_code')
    expect(skillBlock).not.toContain('ultrasound_sos_tomography')
    expect(skillBlock).not.toContain('seismic_FWI_original')
    expect(skillBlock).not.toContain('usct_FWI')

    const baselinePrompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
    })
    expect(baselinePrompt).not.toContain('<active_skills>')
  })

  test('can request generic deep reading without naming transfer relationships', async () => {
    const taskRun = await fakeTaskRun()
    await mkdir(join(taskRun.publicDir, 'known_tasks', 'source-a', 'std_code'), {
      recursive: true,
    })
    await writeFile(
      join(taskRun.publicDir, 'known_tasks', 'source-a', 'README.md'),
      '# Source A',
      'utf8',
    )
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      hasKnownTaskMaterials: true,
      knownTaskMaterialsDeepRead: true,
    })

    const knownBlock = prompt.match(
      /<known_task_materials>[\s\S]*<\/known_task_materials>/,
    )?.[0]
    expect(knownBlock).toContain('public/known_tasks/')
    expect(knownBlock).toContain('README.md')
    expect(knownBlock).toContain('std_code')
    expect(knownBlock).toContain('workspace/known_task_materials_notes.md')
    expect(knownBlock).toContain('Known-task synthesis')
    expect(knownBlock).toContain('reusable')
    expect(knownBlock).toContain('paradigm mismatches')
    expect(knownBlock).toContain('workspace/plans/round_NN.md')
    expect(knownBlock).not.toContain('workspace/current_task_contract.md')
    expect(knownBlock).not.toContain('current-contract-auditor')
    expect(knownBlock).not.toContain('known-task-auditor')
    expect(knownBlock).not.toContain('objective-compatibility-reviewer')
    expect(knownBlock).not.toContain('experiment-risk-reviewer')
    expect(knownBlock).not.toContain('failure-diagnostic-reviewer')
    expect(knownBlock).not.toContain('compact decision memo')
    expect(knownBlock).not.toContain('must not return raw file contents')
    expect(knownBlock).not.toContain('must not return image payloads')
    expect(knownBlock).not.toContain('reuse_as_is')
    expect(knownBlock).not.toContain('adapt_with_contract_check')
    expect(knownBlock).not.toContain('do_not_reuse')
    expect(knownBlock).not.toContain('transfer')
    expect(knownBlock).not.toContain('hypothesis')
    expect(knownBlock).not.toContain('xray_ptychography_tike')
    expect(knownBlock).not.toContain('conventional_ptychography')
    expect(knownBlock).not.toContain('ultrasound_sos_tomography')
    expect(knownBlock).not.toContain('seismic_FWI_original')
    expect(knownBlock).not.toContain('usct_FWI')
    expect(knownBlock).not.toContain('helps')
  })

  test('injects resume context into the initial prompt', async () => {
    const taskRun = await fakeTaskRun()
    const prompt = await buildInitialSourcePrompt({
      taskRun,
      runtime,
      userTask: '# Demo Task\nSolve it.\n',
      maxRounds: 5,
      resumeContext: {
        runDir: 'output/runs/old_run',
        taskId: 'demo_task',
        latestPlan: '# Previous plan',
        runMemory: '# Previous memory',
        contextEvents: [{ round: 1, subtype: 'compact_boundary', message: 'compacted' }],
      },
    })

    expect(prompt).toContain('<resume_context>')
    expect(prompt).toContain('output/runs/old_run')
    expect(prompt).toContain('Previous plan')
    expect(prompt).toContain('Previous memory')
    expect(prompt).toContain('compact_boundary')
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
    expect(prompt).not.toContain('<diagnostic_hint>')
    expect(prompt).not.toContain('NCC passed while NRMSE failed')
  })

  test('reinjects active skills and run memory into judge feedback prompt', () => {
    const judgeResult: JudgeResult = {
      status: 'fail',
      reward: 0,
      feedback: 'format mismatch',
      raw: {},
    }

    const prompt = buildJudgeFeedbackPrompt({
      round: 1,
      maxRounds: 3,
      judgeResult,
      hasActiveSkills: true,
      activeSkillNames: ['general-skill'],
      runMemory: {
        path: 'workspace/agent_memory.md',
        content: '- Tried baseline solver\n- Next: fix output dtype',
      },
    })

    expect(prompt).toContain('<active_skills>')
    expect(prompt).toContain('At the start of each judge round')
    expect(prompt).toContain('Applied skills checklist')
    expect(prompt).toContain('which skill contract item failed')
    expect(prompt).toContain('general-skill')
    expect(prompt).toContain('<run_memory>')
    expect(prompt).toContain('workspace/agent_memory.md')
    expect(prompt).toContain('fix output dtype')
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
})
