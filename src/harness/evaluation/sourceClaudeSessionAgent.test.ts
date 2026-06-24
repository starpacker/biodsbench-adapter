import { afterEach, describe, expect, test } from 'bun:test'
import { join, resolve } from 'path'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import { getTaskOutputPath, setTaskOutputDirOverride } from '../../utils/task/diskOutput.js'
import {
  buildQueryEngineContextConfig,
  configureEvalAutoCompactEnv,
  configureEvalClaudeContextRoot,
  configureEvalTaskOutputDir,
  configureEvalPythonRuntimeEnv,
  drainFinalizeStateEvents,
  killRunningShellTasksForSession,
  resolveActiveSkillReadRoots,
  resolveQueryEngineCapabilities,
  selectSourceToolPool,
  SourceClaudeSessionAgent,
} from './sourceClaudeSessionAgent.js'
import type { FinalizeSubmissionState } from './finalizeSubmissionTool.js'

function tool(name: string) {
  return { name } as never
}

afterEach(() => {
  setTaskOutputDirOverride(undefined)
})

describe('selectSourceToolPool', () => {
  test('keeps the standard eval tools without Agent or Web tools by default', () => {
    const selected = selectSourceToolPool(
      [
        tool('Read'),
        tool('Write'),
        tool('Edit'),
        tool('MultiEdit'),
        tool('Glob'),
        tool('Grep'),
        tool('Bash'),
        tool('Skill'),
        tool('TodoWrite'),
        tool('Agent'),
        tool('WebFetch'),
        tool('WebSearch'),
        tool('NotebookEdit'),
      ],
      tool('finalize_submission'),
      { enableSkills: false },
    )

    expect(selected.map(item => item.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'Bash',
      'TodoWrite',
      'finalize_submission',
    ])
  })

  test('includes Agent and Web tools only when network and AgentTool are enabled', () => {
    const selected = selectSourceToolPool(
      [
        tool('Read'),
        tool('Bash'),
        tool('TodoWrite'),
        tool('Agent'),
        tool('WebFetch'),
        tool('WebSearch'),
        tool('CompatWebFetch20250305'),
      ],
      tool('finalize_submission'),
      {
        enableSkills: false,
        networkPolicy: 'enabled',
        enableAgentTool: true,
      },
    )

    expect(selected.map(item => item.name)).toEqual([
      'Read',
      'Bash',
      'TodoWrite',
      'Agent',
      'WebFetch',
      'WebSearch',
      'CompatWebFetch20250305',
      'finalize_submission',
    ])
  })

  test('includes native SkillTool only when skills mode is enabled', () => {
    const selected = selectSourceToolPool(
      [
        tool('Read'),
        tool('Write'),
        tool('Bash'),
        tool('Skill'),
        tool('TodoWrite'),
        tool('Agent'),
        tool('WebFetch'),
      ],
      tool('finalize_submission'),
      { enableSkills: true },
    )

    expect(selected.map(item => item.name)).toEqual([
      'Read',
      'Write',
      'Bash',
      'Skill',
      'TodoWrite',
      'finalize_submission',
    ])
  })
})

describe('resolveActiveSkillReadRoots', () => {
  test('returns only explicitly allowed skill roots when skill names are configured', () => {
    const roots = resolveActiveSkillReadRoots({
      enabled: true,
      mode: 'native',
      skillsDir: 'skills/main',
      additionalSkillsDirs: ['skills/extra'],
      allowedSkillNames: ['oracle-ssnp_odt', 'helper'],
      maxActiveSkills: 2,
    })

    expect(roots).toEqual([
      resolve('skills/main', 'oracle-ssnp_odt'),
      resolve('skills/main', 'helper'),
      resolve('skills/extra', 'oracle-ssnp_odt'),
      resolve('skills/extra', 'helper'),
    ])
  })

  test('falls back to configured skills directories when no skill names are configured', () => {
    const roots = resolveActiveSkillReadRoots({
      enabled: true,
      mode: 'native',
      skillsDir: 'skills/main',
      additionalSkillsDirs: ['skills/extra'],
    })

    expect(roots).toEqual([resolve('skills/main'), resolve('skills/extra')])
  })

  test('returns no roots when skills are disabled', () => {
    expect(
      resolveActiveSkillReadRoots({
        enabled: false,
        mode: 'native',
        skillsDir: 'skills/main',
        allowedSkillNames: ['oracle-ssnp_odt'],
      }),
    ).toEqual([])
  })
})

describe('drainFinalizeStateEvents', () => {
  test('emits a terminal finalize event as soon as validation has passed', () => {
    const state: FinalizeSubmissionState = {
      readyForJudge: true,
      summary: 'ready',
      files: ['outputs/case_000.npz'],
      pendingEvents: [
        {
          type: 'submission_validation_passed',
          result: {
            ok: true,
            normalizedFiles: ['outputs/case_000.npz'],
            issues: [],
          },
        },
      ],
    }

    const drained = drainFinalizeStateEvents(state)

    expect(drained.readyForJudge).toBe(true)
    expect(drained.events.map(event => event.type)).toEqual([
      'submission_validation_passed',
      'finalize',
    ])
    expect(drained.events.at(-1)).toEqual({
      type: 'finalize',
      summary: 'ready',
      files: ['outputs/case_000.npz'],
    })
    expect(state.pendingEvents).toEqual([])
  })

  test('does not emit finalize for recoverable validation feedback', () => {
    const state: FinalizeSubmissionState = {
      readyForJudge: false,
      summary: '',
      files: [],
      pendingEvents: [
        {
          type: 'submission_validation_failed',
          result: {
            ok: false,
            normalizedFiles: [],
            issues: [
              {
                code: 'missing_output_file',
                path: 'outputs/case_000.npz',
                message: 'outputs/case_000.npz is missing',
              },
            ],
          },
        },
      ],
    }

    const drained = drainFinalizeStateEvents(state)

    expect(drained.readyForJudge).toBe(false)
    expect(drained.events.map(event => event.type)).toEqual([
      'submission_validation_failed',
    ])
    expect(state.pendingEvents).toEqual([])
  })
})

describe('buildQueryEngineContextConfig', () => {
  test('keeps custom system prompt for eval-minimal compatibility', () => {
    const config = buildQueryEngineContextConfig({
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'disabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
      systemPrompt: 'extra',
    } as never)

    expect(config.customSystemPrompt).toContain('source-native evaluation harness')
    expect(config.appendSystemPrompt).toBeUndefined()
    expect(config.includeDefaultUserContext).toBe(false)
    expect(config.includeSystemContext).toBe(false)
  })

  test('uses append system prompt for eval-safe Claude parity', () => {
    const config = buildQueryEngineContextConfig({
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
      systemPrompt: 'extra',
    } as never)

    expect(config.customSystemPrompt).toBeUndefined()
    expect(config.appendSystemPrompt).toContain('source-native evaluation harness')
    expect(config.includeDefaultUserContext).toBe(false)
    expect(config.includeSystemContext).toBe(false)
  })
})

describe('configureEvalClaudeContextRoot', () => {
  test('scopes Claude default context discovery to the eval run directory', () => {
    const previous = getOriginalCwd()
    const runDir = resolve('tmp', 'eval-run')
    try {
      configureEvalClaudeContextRoot({ runDir } as never)

      expect(getOriginalCwd()).toBe(runDir)
    } finally {
      setOriginalCwd(previous)
    }
  })
})

describe('resolveQueryEngineCapabilities', () => {
  test('keeps commands mcp and agents disabled for eval-safe profile by default', () => {
    const caps = resolveQueryEngineCapabilities({
      contextOptions: {
        profile: 'eval-safe-claude-parity',
        networkPolicy: 'disabled',
        runMemory: true,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
    } as never)

    expect(caps).toEqual({ commands: [], mcpClients: [], agents: [] })
  })

  test('keeps agents disabled when network policy is disabled even if AgentTool is requested', () => {
    const caps = resolveQueryEngineCapabilities({
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'disabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: true,
      },
    } as never)

    expect(caps.commands).toEqual([])
    expect(caps.mcpClients).toEqual([])
    expect(caps.agents).toEqual([])
  })

  test('exposes built-in agents when network and AgentTool are enabled under eval-minimal', () => {
    const caps = resolveQueryEngineCapabilities({
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'enabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: true,
      },
    } as never)

    expect(caps.commands).toEqual([])
    expect(caps.mcpClients).toEqual([])
    expect(caps.agents.map(agent => agent.agentType)).toContain('general-purpose')
  })

  test('returns no agents under eval-minimal when AgentTool is disabled', () => {
    const caps = resolveQueryEngineCapabilities({
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'disabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
    } as never)

    expect(caps).toEqual({ commands: [], mcpClients: [], agents: [] })
  })
})

describe('configureEvalTaskOutputDir', () => {
  test('keeps background Bash outputs inside logs/agent/tasks for eval reads', () => {
    const runDir = resolve('tmp', 'run')
    const taskRun = {
      runDir,
      logsDir: join(runDir, 'logs'),
    } as never

    configureEvalTaskOutputDir(taskRun)

    expect(getTaskOutputPath('bg')).toBe(
      join(runDir, 'logs', 'agent', 'tasks', 'bg.output'),
    )
  })
})

describe('configureEvalPythonRuntimeEnv', () => {
  test('forces observable Python output and avoids bytecode writes in eval Bash runs', () => {
    const previous = process.env.PYTHONUNBUFFERED
    const previousDontWriteBytecode = process.env.PYTHONDONTWRITEBYTECODE
    try {
      delete process.env.PYTHONUNBUFFERED
      delete process.env.PYTHONDONTWRITEBYTECODE

      configureEvalPythonRuntimeEnv()

      expect(process.env.PYTHONUNBUFFERED).toBe('1')
      expect(process.env.PYTHONDONTWRITEBYTECODE).toBe('1')
    } finally {
      if (previous === undefined) delete process.env.PYTHONUNBUFFERED
      else process.env.PYTHONUNBUFFERED = previous
      if (previousDontWriteBytecode === undefined) delete process.env.PYTHONDONTWRITEBYTECODE
      else process.env.PYTHONDONTWRITEBYTECODE = previousDontWriteBytecode
    }
  })
})

describe('eval auto-compact environment', () => {
  test('does not disable Claude auto-compact by default', () => {
    const previous = process.env.DISABLE_AUTO_COMPACT
    try {
      delete process.env.DISABLE_AUTO_COMPACT
      configureEvalAutoCompactEnv({ disableAutoCompact: false })
      expect(process.env.DISABLE_AUTO_COMPACT).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.DISABLE_AUTO_COMPACT
      else process.env.DISABLE_AUTO_COMPACT = previous
    }
  })

  test('can explicitly disable Claude auto-compact for compatibility debugging', () => {
    const previous = process.env.DISABLE_AUTO_COMPACT
    try {
      delete process.env.DISABLE_AUTO_COMPACT
      configureEvalAutoCompactEnv({ disableAutoCompact: true })
      expect(process.env.DISABLE_AUTO_COMPACT).toBe('1')
    } finally {
      if (previous === undefined) delete process.env.DISABLE_AUTO_COMPACT
      else process.env.DISABLE_AUTO_COMPACT = previous
    }
  })
})

describe('killRunningShellTasksForSession', () => {
  function makeShellTask(
    id: string,
    status: 'running' | 'completed',
    callbacks: {
      killed: string[]
      cleaned: string[]
      unregistered: string[]
    },
  ) {
    const shellCommand = {
      kill: () => callbacks.killed.push(id),
      cleanup: () => callbacks.cleaned.push(id),
      result: Promise.resolve({
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
      }),
      status: 'backgrounded',
    } as never

    return {
      id,
      type: 'local_bash',
      status,
      description: id,
      startTime: Date.now(),
      outputFile: `${id}.output`,
      outputOffset: 0,
      notified: false,
      command: `python ${id}.py`,
      completionStatusSentInAttachment: false,
      shellCommand,
      unregisterCleanup: () => callbacks.unregistered.push(id),
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    } as never
  }

  test('kills every running local Bash task in the eval session store', () => {
    const callbacks = {
      killed: [] as string[],
      cleaned: [] as string[],
      unregistered: [] as string[],
    }
    const store = createStore({
      ...getDefaultAppState(),
      tasks: {
        runningMain: makeShellTask('runningMain', 'running', callbacks),
        runningNested: {
          ...makeShellTask('runningNested', 'running', callbacks),
          agentId: 'skill-agent' as never,
        },
        alreadyDone: makeShellTask('alreadyDone', 'completed', callbacks),
      },
    })

    killRunningShellTasksForSession(store.getState, store.setState)

    expect(callbacks.killed).toEqual(['runningMain', 'runningNested'])
    expect(callbacks.cleaned).toEqual(['runningMain', 'runningNested'])
    expect(callbacks.unregistered).toEqual(['runningMain', 'runningNested'])
    expect(store.getState().tasks.runningMain?.status).toBe('killed')
    expect(store.getState().tasks.runningNested?.status).toBe('killed')
    expect(store.getState().tasks.alreadyDone?.status).toBe('completed')
  })

  test('SourceClaudeSessionAgent.dispose drains its session-local Bash registry', async () => {
    const callbacks = {
      killed: [] as string[],
      cleaned: [] as string[],
      unregistered: [] as string[],
    }
    const runDir = resolve('tmp', 'source-session-dispose')
    const agent = new SourceClaudeSessionAgent({
      taskRun: {
        taskId: 'dispose-test',
        runId: 'dispose-test-run',
        runDir,
        judgeDir: join(runDir, 'private'),
        publicDir: join(runDir, 'public'),
        workspaceDir: join(runDir, 'workspace'),
        outputsDir: join(runDir, 'workspace', 'outputs'),
        logsDir: join(runDir, 'logs'),
        taskDir: runDir,
        manifest: {
          version: 1,
          task_id: 'dispose-test',
        },
      },
      maxRounds: 1,
      userTask: '',
      runtime: {
        python: process.execPath,
        displayPath: process.execPath,
        envName: 'test',
      },
      contextOptions: {
        profile: 'eval-minimal',
        networkPolicy: 'disabled',
        runMemory: false,
        recordContextEvents: true,
        reInjectActiveSkillsEachRound: true,
        includeClaudeDefaultUserContext: false,
        enableSlashCommands: false,
        enableMcpClients: false,
        enableAgentTool: false,
      },
    } as never)
    const stateAccess = agent as unknown as {
      getAppState: () => ReturnType<typeof getDefaultAppState>
      setAppState: (updater: (prev: ReturnType<typeof getDefaultAppState>) => ReturnType<typeof getDefaultAppState>) => void
    }
    stateAccess.setAppState(prev => ({
      ...prev,
      tasks: {
        liveEvalShell: makeShellTask('liveEvalShell', 'running', callbacks),
      },
    }))

    await agent.dispose()

    expect(callbacks.killed).toEqual(['liveEvalShell'])
    expect(stateAccess.getAppState().tasks.liveEvalShell?.status).toBe('killed')
  })
})
