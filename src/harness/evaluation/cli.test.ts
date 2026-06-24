import { describe, expect, test } from 'bun:test'
import {
  configureEvaluationBashTimeoutEnv,
  exitCodeForLoopStatus,
  parseEvaluationCliArgs,
} from './cli.js'

describe('parseEvaluationCliArgs', () => {
  test('requires task id and parses loop controls', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--max-rounds',
      '4',
      '--timeout-seconds',
      '120',
      '--concurrency',
      '3',
      '--worker-timeout-grace-seconds',
      '15',
      '--max-turns-per-round',
      '9',
      '--agent-runtime',
      'source',
      '--runs-dir',
      'output/runs',
    ])

    expect(parsed.taskId).toBe('demo_task')
    expect(parsed.maxRounds).toBe(4)
    expect(parsed.maxTurnsPerRound).toBe(9)
    expect(parsed.timeoutSeconds).toBe(120)
    expect(parsed.concurrency).toBe(3)
    expect(parsed.workerTimeoutGraceSeconds).toBe(15)
    expect(parsed.runsDir).toBe('output/runs')
    expect(parsed.agentRuntime).toBe('source')
    expect(parsed.temperature).toBe(1)
    expect(parsed.thinking).toBe('disabled')
    expect(parsed.skillOptions).toEqual({
      enabled: false,
      skillsDir: 'skills',
      mode: 'native',
    })
    expect(parsed.knownTaskMaterials).toEqual({
      enabled: false,
      sourceTaskIds: [],
    })
    expect(parsed.contextOptions.networkPolicy).toBe('disabled')
    expect(parsed.contextOptions.enableAgentTool).toBe(false)
    expect(parsed.taskIds).toEqual(['demo_task'])
    expect(parsed.systemPromptPath).toBeUndefined()
    expect(parsed.userPromptPaths).toEqual([])
  })

  test('parses repeatable user prompt files', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'usct_FWI',
      '--user-prompt',
      'config/prompts/base.md',
      '--user-prompt',
      'config/prompts/usct-fwi-known-ab-user-prompt.md',
    ])

    expect(parsed.userPromptPaths).toEqual([
      'config/prompts/base.md',
      'config/prompts/usct-fwi-known-ab-user-prompt.md',
    ])
  })

  test('parses repeated tasks for source batch mode', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'task_a,task_b',
      '--task',
      'task_c',
      '--quiet',
    ])

    expect(parsed.taskId).toBe('task_a')
    expect(parsed.taskIds).toEqual(['task_a', 'task_b', 'task_c'])
    expect(parsed.maxTurnsPerRound).toBeUndefined()
    expect(parsed.verbose).toBe(false)
  })

  test('rejects removed legacy subprocess runtime', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--agent-runtime', 'legacy-subprocess']),
    ).toThrow('legacy-subprocess has been removed')
  })

  test('parses temperature and thinking controls', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--temperature',
      '0.2',
      '--thinking',
      'adaptive',
      '--judge-feedback-level',
      'metric_full',
    ])

    expect(parsed.temperature).toBe(0.2)
    expect(parsed.thinking).toBe('adaptive')
    expect(parsed.judgeFeedbackLevel).toBe('metric_full')
  })

  test('parses native SkillTool controls only when explicitly enabled', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--enable-skills',
      '--skills-dir',
      'skills',
    ])

    expect(parsed.skillOptions).toEqual({
      enabled: true,
      skillsDir: 'skills',
      mode: 'native',
    })
  })

  test('parses repeatable known task materials without enabling skills', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'usct_FWI',
      '--known-task',
      'ultrasound_sos_tomography',
      '--known-task',
      'seismic_FWI_original',
    ])

    expect(parsed.knownTaskMaterials).toEqual({
      enabled: true,
      sourceTaskIds: ['ultrasound_sos_tomography', 'seismic_FWI_original'],
    })
    expect(parsed.skillOptions.enabled).toBe(false)
  })

  test('parses known task deep-read protocol without enabling skills', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'usct_FWI',
      '--known-task',
      'ultrasound_sos_tomography',
      '--known-task-deep-read',
    ])

    expect(parsed.knownTaskMaterials).toEqual({
      enabled: true,
      sourceTaskIds: ['ultrasound_sos_tomography'],
      deepRead: true,
    })
    expect(parsed.skillOptions.enabled).toBe(false)
  })

  test('parses native SkillTool overlays and filtering controls', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--enable-skills',
      '--skills-dir',
      'skills',
      '--skills-dir',
      'output/oracle-skill-ablation/validation/cycle/candidate-skills/skills',
      '--skill-name',
      'ci-general-active',
      '--skill-name',
      'ci-general-candidate',
      '--max-active-skills',
      '2',
    ])

    expect(parsed.skillOptions).toEqual({
      enabled: true,
      skillsDir: 'skills',
      additionalSkillsDirs: ['output/oracle-skill-ablation/validation/cycle/candidate-skills/skills'],
      allowedSkillNames: ['ci-general-active', 'ci-general-candidate'],
      maxActiveSkills: 2,
      mode: 'native',
    })
  })

  test('parses eval-safe context profile without unsafe defaults', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--context-profile',
      'eval-safe-claude-parity',
      '--enable-run-memory',
    ])

    expect(parsed.contextOptions).toMatchObject({
      profile: 'eval-safe-claude-parity',
      runMemory: true,
      recordContextEvents: true,
      reInjectActiveSkillsEachRound: true,
      includeClaudeDefaultUserContext: false,
      enableSlashCommands: false,
      enableMcpClients: false,
      enableAgentTool: false,
      networkPolicy: 'disabled',
    })
  })

  test('disables network and AgentTool by default and accepts explicit opt-in', () => {
    const defaultParsed = parseEvaluationCliArgs(['--task', 'demo_task'])
    expect(defaultParsed.contextOptions.networkPolicy).toBe('disabled')
    expect(defaultParsed.contextOptions.enableAgentTool).toBe(false)

    const networkOnly = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--network-policy',
      'enabled',
    ])
    expect(networkOnly.contextOptions.networkPolicy).toBe('enabled')
    expect(networkOnly.contextOptions.enableAgentTool).toBe(false)

    const agentEnabled = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--network-policy',
      'enabled',
      '--enable-agent-tool',
    ])
    expect(agentEnabled.contextOptions.networkPolicy).toBe('enabled')
    expect(agentEnabled.contextOptions.enableAgentTool).toBe(true)

    const disabled = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--network-policy',
      'enabled',
      '--disable-agent-tool',
    ])
    expect(disabled.contextOptions.networkPolicy).toBe('enabled')
    expect(disabled.contextOptions.enableAgentTool).toBe(false)
  })

  test('rejects AgentTool when network policy is disabled', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--enable-agent-tool']),
    ).toThrow('networkPolicy disabled')

    expect(() =>
      parseEvaluationCliArgs([
        '--task',
        'demo_task',
        '--network-policy',
        'disabled',
        '--enable-agent-tool',
      ]),
    ).toThrow('networkPolicy disabled')
  })

  test('parses explicit Claude default user context for safe parity runs', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--context-profile',
      'eval-safe-claude-parity',
      '--include-claude-default-user-context',
    ])

    expect(parsed.contextOptions.includeClaudeDefaultUserContext).toBe(true)
  })

  test('requires explicit unsafe allowance for full Claude context profile', () => {
    expect(() =>
      parseEvaluationCliArgs([
        '--task',
        'demo_task',
        '--context-profile',
        'full-claude-unsafe',
      ]),
    ).toThrow('--allow-unsafe-context')

    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--context-profile',
      'full-claude-unsafe',
      '--allow-unsafe-context',
    ])

    expect(parsed.contextOptions.profile).toBe('full-claude-unsafe')
    expect(parsed.contextOptions.includeClaudeDefaultUserContext).toBe(true)
  })

  test('parses resume run and enables run memory', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--resume-run',
      'output/runs/demo_task_1',
    ])

    expect(parsed.contextOptions.resumeRun).toBe('output/runs/demo_task_1')
    expect(parsed.contextOptions.runMemory).toBe(true)
  })

  test('rejects skills directory without explicit skills mode', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--skills-dir', 'skills']),
    ).toThrow('--skills-dir requires --enable-skills')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--skill-name', 'ci-general-active']),
    ).toThrow('--skill-name requires --enable-skills')
  })

  test('rejects invalid temperature and thinking values', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--temperature', 'hot']),
    ).toThrow('--temperature')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--temperature', '2']),
    ).toThrow('--temperature')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--thinking', 'enabled']),
    ).toThrow('--thinking')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--judge-feedback-level', 'verbose']),
    ).toThrow('--judge-feedback-level')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--network-policy', 'offline']),
    ).toThrow('--network-policy')
  })

  test('rejects deep-read protocol without known task materials', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'usct_FWI', '--known-task-deep-read']),
    ).toThrow('--known-task-deep-read requires at least one --known-task')
  })

  test('maps loop status to process exit code', () => {
    expect(exitCodeForLoopStatus('success')).toBe(0)
    expect(exitCodeForLoopStatus('failed')).toBe(1)
    expect(exitCodeForLoopStatus('timeout')).toBe(1)
    expect(exitCodeForLoopStatus('infra_error')).toBe(1)
  })

  test('configures bash timeout cap from worker loop timeout', () => {
    const previous = process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
    try {
      delete process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
      configureEvaluationBashTimeoutEnv(123)
      expect(process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS).toBe('123000')

      process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS = '60000'
      configureEvaluationBashTimeoutEnv(123)
      expect(process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS).toBe('60000')
    } finally {
      if (previous === undefined) delete process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS
      else process.env.SOURCE_EVAL_MAX_BASH_TIMEOUT_MS = previous
    }
  })
})
