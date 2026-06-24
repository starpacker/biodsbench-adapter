import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import {
  applyEvaluationModelProfile,
  buildEvaluationConfigPlan,
  parseEvaluationConfigRunnerArgs,
  parseEvaluationRunnerConfig,
  runProcess,
  resolveEvaluationConfigRepoRoot,
  resolveEvaluationModelProfile,
} from './configRunner.js'

describe('evaluation config runner', () => {
  test('parses a config-driven known-task materials run with repeat and condition overrides', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'xray_ptychography_tike',
      tasksDir: 'tasks',
      runsRoot: 'output/known-task-materials/xray_ptychography_tike',
      maxRounds: 5,
      timeoutSeconds: 18000,
      judgeFeedbackLevel: 'metric_status',
      temperature: 1,
      thinking: 'disabled',
      conditions: [
        {
          name: 'A_deepread_conventional_ptychography',
          judgeFeedbackLevel: 'metric_full',
          knownTaskDeepRead: true,
          knownTasks: ['conventional_ptychography'],
        },
      ],
    })

    const plan = buildEvaluationConfigPlan({
      config,
      conditionName: 'A_deepread_conventional_ptychography',
      repeat: 2,
      timestamp: 'xray_migration_20260610_120000',
    })

    expect(plan.runs.length).toBe(2)
    expect(plan.runs[0].args).toEqual([
      'src/harness/evaluation/cli.ts',
      '--task',
      'xray_ptychography_tike',
      '--tasks-dir',
      'tasks',
      '--runs-dir',
      'output/known-task-materials/xray_ptychography_tike/A_deepread_conventional_ptychography/repeat_01',
      '--max-rounds',
      '5',
      '--timeout-seconds',
      '18000',
      '--judge-feedback-level',
      'metric_full',
      '--temperature',
      '1',
      '--thinking',
      'disabled',
      '--timestamp',
      'xray_migration_20260610_120000_01',
      '--known-task',
      'conventional_ptychography',
      '--known-task-deep-read',
      '--network-policy',
      'disabled',
    ])
    expect(plan.runs[1].args).toContain('xray_migration_20260610_120000_02')
  })

  test('applies condition-level model profile over config defaults', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'demo_task',
      llm: {
        profile: 'default-profile',
        profilesPath: 'config/eval-model-profiles.local.json',
      },
      conditions: [
        {
          name: 'alt_model',
          modelProfile: 'condition-profile',
        },
      ],
    })

    expect(
      resolveEvaluationModelProfile({
        config,
        conditionName: 'alt_model',
        cliModelProfile: undefined,
        profilesConfig: {
          profiles: {
            'default-profile': {
              provider: 'anthropic-compatible',
              baseUrl: 'https://default.example',
              apiKey: 'default-key',
              model: 'default-model',
            },
            'condition-profile': {
              provider: 'anthropic-compatible',
              baseUrl: 'https://condition.example',
              apiKey: 'condition-key',
              model: 'condition-model',
            },
          },
        },
      })?.name,
    ).toBe('condition-profile')
  })

  test('CLI model profile overrides condition and config profile defaults', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'demo_task',
      llm: { profile: 'config-profile' },
      conditions: [{ name: 'demo', modelProfile: 'condition-profile' }],
    })

    expect(
      resolveEvaluationModelProfile({
        config,
        conditionName: 'demo',
        cliModelProfile: 'cli-profile',
        profilesConfig: {
          profiles: {
            'config-profile': {
              provider: 'anthropic-compatible',
              baseUrl: 'https://config.example',
              apiKey: 'config-key',
              model: 'config-model',
            },
            'condition-profile': {
              provider: 'anthropic-compatible',
              baseUrl: 'https://condition.example',
              apiKey: 'condition-key',
              model: 'condition-model',
            },
            'cli-profile': {
              provider: 'anthropic-compatible',
              baseUrl: 'https://cli.example',
              apiKey: 'cli-key',
              model: 'cli-model',
            },
          },
        },
      })?.name,
    ).toBe('cli-profile')
  })

  test('maps an anthropic-compatible model profile to generic and Claude source env names', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'https://stale.example',
      BASE_URL: 'https://stale.example',
    }

    applyEvaluationModelProfile(
      {
        name: 'gpugeek-opus',
        provider: 'anthropic-compatible',
        baseUrl: 'https://gateway.example/v1/messages',
        apiKey: 'profile-key',
        model: 'Vendor/Claude-Opus',
        extraEnv: {
          ENABLE_TOOL_SEARCH: 'false',
        },
      },
      env,
    )

    expect(env.API_KEY).toBe('profile-key')
    expect(env.BASE_URL).toBe('https://gateway.example/v1/messages')
    expect(env.MODEL_NAME).toBe('Vendor/Claude-Opus')
    expect(env.GATEWAY_PROTOCOL).toBe('anthropic')
    expect(env.ANTHROPIC_API_KEY).toBe('profile-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example/v1/messages')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('Vendor/Claude-Opus')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('Vendor/Claude-Opus')
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
  })

  test('anthropic first-party profiles clear stale gateway URLs', () => {
    const env: Record<string, string | undefined> = {
      BASE_URL: 'https://stale-gateway.example',
      ANTHROPIC_BASE_URL: 'https://stale-gateway.example',
    }

    applyEvaluationModelProfile(
      {
        name: 'anthropic',
        provider: 'anthropic',
        apiKey: 'anthropic-key',
        model: 'claude-model',
      },
      env,
    )

    expect(env.API_KEY).toBe('anthropic-key')
    expect(env.ANTHROPIC_API_KEY).toBe('anthropic-key')
    expect(env.MODEL_NAME).toBe('claude-model')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-model')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-model')
    expect(env.BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  test('parses config runner CLI arguments', () => {
    expect(
      parseEvaluationConfigRunnerArgs([
        '--config',
        'config/known-task-materials-xray-ptychography.json',
        '--condition',
        'A',
        '--repeat',
        '3',
        '--model-profile',
        'gpugeek-opus',
        '--model-config',
        'config/eval-model-profiles.local.json',
        '--dry-run',
        '--plan-json',
      ]),
    ).toEqual({
      configPath: 'config/known-task-materials-xray-ptychography.json',
      conditionName: 'A',
      repeat: 3,
      modelProfile: 'gpugeek-opus',
      modelConfigPath: 'config/eval-model-profiles.local.json',
      dryRun: true,
      planJson: true,
    })
  })

  test('resolves repo root from cwd when config files live under output', () => {
    expect(
      resolveEvaluationConfigRepoRoot(
        'output/oracle-skill-ablation/demo/configs/variant.json',
      ),
    ).toBe(process.cwd())
  })

  test('passes config and condition context options to generated CLI args', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'usct_FWI',
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        includeClaudeDefaultUserContext: true,
        enableAgentTool: false,
      },
      conditions: [
        {
          name: 'agent_enabled',
          contextOptions: {
            networkPolicy: 'enabled',
            enableAgentTool: true,
            reInjectActiveSkillsEachRound: false,
          },
          knownTasks: ['ultrasound_sos_tomography', 'seismic_FDFWI'],
        },
      ],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'agent_enabled',
      repeat: 1,
      timestamp: 'usct_20260614_120000',
    }).runs[0].args

    expect(config.contextOptions?.enableAgentTool).toBe(false)
    expect(config.contextOptions?.networkPolicy).toBe('disabled')
    expect(config.conditions[0].contextOptions?.enableAgentTool).toBe(true)
    expect(config.conditions[0].contextOptions?.networkPolicy).toBe('enabled')
    expect(args).toContain('--context-profile')
    expect(args).toContain('eval-safe-claude-parity')
    expect(args).toContain('--network-policy')
    expect(args).toContain('enabled')
    expect(args).toContain('--enable-run-memory')
    expect(args).toContain('--include-claude-default-user-context')
    expect(args).toContain('--disable-skill-reinject')
    expect(args).toContain('--enable-agent-tool')
    expect(args).not.toContain('--disable-agent-tool')
  })

  test('passes top-level and condition user prompt paths to generated CLI args in order', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'usct_FWI',
      userPromptPath: 'config/prompts/base.md',
      userPromptPaths: ['config/prompts/shared.md'],
      conditions: [
        {
          name: 'agent_enabled',
          userPromptPath: 'config/prompts/usct-fwi-known-ab-user-prompt.md',
          userPromptPaths: ['config/prompts/usct-extra.md'],
          knownTasks: ['ultrasound_sos_tomography', 'seismic_FDFWI'],
        },
      ],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'agent_enabled',
      repeat: 1,
      timestamp: 'usct_20260614_120000',
    }).runs[0].args

    const promptArgs = args
      .map((value, index) => (value === '--user-prompt' ? args[index + 1] : undefined))
      .filter(Boolean)
    expect(promptArgs).toEqual([
      'config/prompts/base.md',
      'config/prompts/shared.md',
      'config/prompts/usct-fwi-known-ab-user-prompt.md',
      'config/prompts/usct-extra.md',
    ])
  })

  test('passes top-level skill options to generated CLI args', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      skills: {
        enabled: true,
        skillsDir: 'output/oracle-skills/SSNP_ODT-gpugeek-opus/skills',
        skillNames: ['oracle-ssnp_odt'],
        maxActiveSkills: 1,
      },
      conditions: [{ name: 'full_oracle_skill' }],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'full_oracle_skill',
      repeat: 1,
      timestamp: 'oracle_skill_eval_20260616_120000',
    }).runs[0].args

    expect(args).toContain('--enable-skills')
    expect(args).toContain('--skills-dir')
    expect(args).toContain('output/oracle-skills/SSNP_ODT-gpugeek-opus/skills')
    expect(args).toContain('--skill-name')
    expect(args).toContain('oracle-ssnp_odt')
    expect(args).toContain('--max-active-skills')
    expect(args).toContain('1')
  })

  test('lets condition skill options override top-level skill options', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      skills: {
        enabled: true,
        skillsDir: 'output/oracle-skills/base/skills',
        skillNames: ['base-skill'],
        maxActiveSkills: 1,
      },
      conditions: [
        {
          name: 'ablated_skill',
          skills: {
            enabled: true,
            skillsDir: 'output/oracle-skills/ablated/skills',
            additionalSkillsDirs: ['output/oracle-skills/common/skills'],
            skillNames: ['ablated-skill'],
            maxActiveSkills: 2,
          },
        },
      ],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'ablated_skill',
      repeat: 1,
      timestamp: 'oracle_skill_eval_20260616_120000',
    }).runs[0].args

    expect(args).toContain('--enable-skills')
    expect(args).toContain('output/oracle-skills/ablated/skills')
    expect(args).toContain('output/oracle-skills/common/skills')
    expect(args).toContain('ablated-skill')
    expect(args).toContain('2')
    expect(args).not.toContain('output/oracle-skills/base/skills')
    expect(args).not.toContain('base-skill')
  })

  test('rejects solver-facing ablation leak tokens in condition paths', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      conditions: [
        {
          name: 'manual_drop_050_070',
          runsRoot: 'output/oracle-skill-ablation',
        },
      ],
    })

    expect(() =>
      buildEvaluationConfigPlan({
        config,
        conditionName: 'manual_drop_050_070',
        repeat: 1,
        timestamp: 'oracle_skill_eval_20260616_120000',
      }),
    ).toThrow('solver-facing ablation leak')
  })

  test('allows timestamp date digits that resemble compact operation indexes', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      conditions: [{ name: 'oracle_skill' }],
    })

    expect(() =>
      buildEvaluationConfigPlan({
        config,
        conditionName: 'oracle_skill',
        repeat: 1,
        timestamp: 'oracle_skill_cumulative_safe_run_20260623_183036',
      }),
    ).not.toThrow()
  })

  test('still rejects explicit ablation tokens in timestamps', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      conditions: [{ name: 'oracle_skill' }],
    })

    expect(() =>
      buildEvaluationConfigPlan({
        config,
        conditionName: 'oracle_skill',
        repeat: 1,
        timestamp: 'manual_drop_050_070_20260623_183036',
      }),
    ).toThrow('solver-facing ablation leak')
  })

  test('rejects solver-facing ablation leak tokens in skill paths', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      skills: {
        enabled: true,
        skillsDir: 'output/oracle-skills/drop_050_070/skills',
        skillNames: ['oracle-ssnp_odt'],
      },
      conditions: [{ name: 'oracle_skill' }],
    })

    expect(() =>
      buildEvaluationConfigPlan({
        config,
        conditionName: 'oracle_skill',
        repeat: 1,
        timestamp: 'oracle_skill_eval_20260616_120000',
      }),
    ).toThrow('solver-facing ablation leak')
  })

  test('rejects enabled skill options without a skills directory', () => {
    expect(() =>
      parseEvaluationRunnerConfig({
        task: 'SSNP_ODT',
        skills: {
          enabled: true,
          skillNames: ['oracle-ssnp_odt'],
        },
        conditions: [{ name: 'full_oracle_skill' }],
      }),
    ).toThrow('skills.skillsDir')
  })

  test('does not pass disabled skill options to generated CLI args', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'SSNP_ODT',
      skills: {
        enabled: false,
        skillsDir: 'output/oracle-skills/disabled/skills',
        skillNames: ['disabled-skill'],
      },
      conditions: [{ name: 'no_skills' }],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'no_skills',
      repeat: 1,
      timestamp: 'oracle_skill_eval_20260616_120000',
    }).runs[0].args

    expect(args).not.toContain('--enable-skills')
    expect(args).not.toContain('--skills-dir')
    expect(args).not.toContain('--skill-name')
    expect(args).not.toContain('--max-active-skills')
  })

  test('allows condition context options to disable AgentTool explicitly', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'demo_task',
      contextOptions: {
        networkPolicy: 'enabled',
        enableAgentTool: true,
      },
      conditions: [
        {
          name: 'agent_disabled',
          contextOptions: {
            networkPolicy: 'disabled',
            enableAgentTool: false,
          },
        },
      ],
    })

    const args = buildEvaluationConfigPlan({
      config,
      conditionName: 'agent_disabled',
      repeat: 1,
      timestamp: 'demo_20260614_120000',
    }).runs[0].args

    expect(args).toContain('--disable-agent-tool')
    expect(args).toContain('--network-policy')
    expect(args).toContain('disabled')
    expect(args).not.toContain('--enable-agent-tool')
  })

  test('rejects AgentTool when merged config network policy is disabled', () => {
    const config = parseEvaluationRunnerConfig({
      task: 'demo_task',
      contextOptions: {
        enableAgentTool: true,
      },
      conditions: [{ name: 'agent_without_network' }],
    })

    expect(() =>
      buildEvaluationConfigPlan({
        config,
        conditionName: 'agent_without_network',
        repeat: 1,
        timestamp: 'demo_20260616_120000',
      }),
    ).toThrow('networkPolicy disabled')
  })

  test('rejects invalid context option values in config files', () => {
    expect(() =>
      parseEvaluationRunnerConfig({
        task: 'demo_task',
        contextOptions: {
          profile: 'unsafe-ish',
        },
        conditions: [{ name: 'demo' }],
      }),
    ).toThrow('contextOptions.profile')

    expect(() =>
      parseEvaluationRunnerConfig({
        task: 'demo_task',
        conditions: [
          {
            name: 'demo',
            contextOptions: {
              enableAgentTool: 'yes',
            },
          },
        ],
      }),
    ).toThrow('conditions[0].contextOptions.enableAgentTool')

    expect(() =>
      parseEvaluationRunnerConfig({
        task: 'demo_task',
        contextOptions: {
          networkPolicy: 'maybe',
        },
        conditions: [{ name: 'demo' }],
      }),
    ).toThrow('contextOptions.networkPolicy')
  })

  test('runProcess watchdog terminates a stuck child process tree', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 38,
      kill() {},
    })
    const signals: NodeJS.Signals[] = []

    const code = await runProcess(['child.ts'], process.cwd(), {
      timeoutMs: 1,
      killGraceMs: 1,
      spawnProcess: () => child as never,
      terminateProcessTree: (_child, signal) => signals.push(signal),
    })

    expect(code).toBe(124)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('runProcess terminates a stuck child process tree on parent signals', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 38,
      kill() {},
    })
    const signals: NodeJS.Signals[] = []

    const running = runProcess(['child.ts'], process.cwd(), {
      timeoutMs: 1000,
      killGraceMs: 1,
      spawnProcess: () => child as never,
      terminateProcessTree: (_child, signal) => signals.push(signal),
    })

    process.emit('SIGTERM')

    await expect(running).resolves.toBe(143)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('runProcess clears its watchdog when the child exits normally', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 38,
      kill() {},
    })
    const signals: NodeJS.Signals[] = []

    const running = runProcess(['child.ts'], process.cwd(), {
      timeoutMs: 1000,
      killGraceMs: 1,
      spawnProcess: () => child as never,
      terminateProcessTree: (_child, signal) => signals.push(signal),
    })
    child.emit('exit', 0)

    await expect(running).resolves.toBe(0)
    expect(signals).toEqual([])
  })
})
