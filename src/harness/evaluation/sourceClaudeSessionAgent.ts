import './sourceBootstrap.js'
import { dirname, join, resolve } from 'path'
import { clearCommandMemoizationCaches } from '../../commands.js'
import { QueryEngine } from '../../QueryEngine.js'
import type { QueryEngineConfig } from '../../QueryEngine.js'
import { getSystemContext, getUserContext } from '../../context.js'
import {
  clearExplicitProjectSkillsDirsForSession,
  setExplicitProjectSkillsDirsForSession,
} from '../../skills/loadSkillsDir.js'
import { setOriginalCwd } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { killTask } from '../../tasks/LocalShellTask/killShellTasks.js'
import { getBuiltInAgents } from '../../tools/AgentTool/builtInAgents.js'
import { getTools } from '../../tools.js'
import type { Tools } from '../../Tool.js'
import { setSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { setTaskOutputDirOverride } from '../../utils/task/diskOutput.js'
import { createFinalizeSubmissionTool, type FinalizeSubmissionState } from './finalizeSubmissionTool.js'
import { createHarnessCanUseTool } from './harnessCanUseTool.js'
import {
  canUseEvaluationAgentTool,
  isEvaluationNetworkToolName,
  normalizeEvaluationNetworkPolicy,
  validateEvaluationNetworkPolicy,
} from './networkPolicy.js'
import { sourceEventsFromSdkMessage } from './sdkMessageAdapter.js'
import { buildSourceSystemPrompt } from './sourceContextBuilder.js'
import { buildSourceLlmQueryOptions } from './sourceLlmOptions.js'
import {
  diffPublicSnapshots,
  restorePublicSnapshotMutations,
  takePublicSnapshot,
  type PublicRestoreResult,
  type PublicSnapshot,
} from './sourcePublicIntegrity.js'
import type {
  EvaluationNetworkPolicy,
  SourceAgentEvent,
  SourceAgentSession,
  SourceAgentStartInput,
  SourceAgentTurnInput,
} from './types.js'

const STANDARD_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
])

export function selectSourceToolPool(
  baseTools: Tools,
  finalizeTool: Tools[number],
  options?: {
    enableSkills?: boolean
    networkPolicy?: EvaluationNetworkPolicy
    enableAgentTool?: boolean
  },
): Tools {
  const allowedToolNames = new Set(STANDARD_TOOL_NAMES)
  if (options?.enableSkills) allowedToolNames.add('Skill')
  const networkPolicy = normalizeEvaluationNetworkPolicy(options?.networkPolicy)
  const allowAgent = canUseEvaluationAgentTool(options)
  return [
    ...baseTools.filter(tool => {
      if (allowedToolNames.has(tool.name)) return true
      if (tool.name === 'Agent') return allowAgent
      if (isEvaluationNetworkToolName(tool.name)) return networkPolicy === 'enabled'
      return false
    }),
    finalizeTool,
  ]
}

export function resolveActiveSkillReadRoots(
  skillOptions: SourceAgentStartInput['skillOptions'],
): string[] {
  if (!skillOptions?.enabled) return []
  const skillDirs = [
    skillOptions.skillsDir,
    ...(skillOptions.additionalSkillsDirs ?? []),
  ].map(dir => resolve(dir))
  const skillNames = skillOptions.allowedSkillNames ?? []

  if (skillNames.length === 0) return skillDirs
  return skillDirs.flatMap(dir => skillNames.map(name => join(dir, name)))
}

export function drainFinalizeStateEvents(state: FinalizeSubmissionState): {
  events: SourceAgentEvent[]
  readyForJudge: boolean
} {
  const events = state.pendingEvents ?? []
  state.pendingEvents = []
  if (state.readyForJudge) {
    events.push({
      type: 'finalize',
      summary: state.summary,
      files: state.files,
    })
  }
  return { events, readyForJudge: state.readyForJudge }
}

export function buildQueryEngineContextConfig(
  input: Pick<SourceAgentStartInput, 'contextOptions' | 'systemPrompt'>,
): Pick<
  QueryEngineConfig,
  | 'customSystemPrompt'
  | 'appendSystemPrompt'
  | 'includeDefaultUserContext'
  | 'includeSystemContext'
> {
  const profile = input.contextOptions?.profile ?? 'eval-minimal'
  const evalContract = buildSourceSystemPrompt(input.systemPrompt, {
    networkPolicy: normalizeEvaluationNetworkPolicy(input.contextOptions?.networkPolicy),
    agentToolAvailable: canUseEvaluationAgentTool(input.contextOptions),
  })
  if (profile === 'eval-minimal') {
    return {
      customSystemPrompt: evalContract,
      includeDefaultUserContext: false,
      includeSystemContext: false,
    }
  }
  return {
    appendSystemPrompt: evalContract,
    includeDefaultUserContext:
      profile === 'full-claude-unsafe'
        ? true
        : Boolean(input.contextOptions?.includeClaudeDefaultUserContext),
    includeSystemContext: profile === 'full-claude-unsafe',
  }
}

function loadEvalSafeCommands(): QueryEngineConfig['commands'] {
  return []
}

function loadEvalSafeMcpClients(): QueryEngineConfig['mcpClients'] {
  return []
}

function loadEvalSafeAgents(): QueryEngineConfig['agents'] {
  return getBuiltInAgents()
}

export function resolveQueryEngineCapabilities(
  input: Pick<SourceAgentStartInput, 'contextOptions'>,
): Pick<QueryEngineConfig, 'commands' | 'mcpClients' | 'agents'> {
  const options = input.contextOptions
  const networkPolicy = normalizeEvaluationNetworkPolicy(options?.networkPolicy)
  if (networkPolicy === 'disabled') {
    return {
      commands: [],
      mcpClients: [],
      agents: [],
    }
  }
  if (!options || options.profile === 'eval-minimal') {
    return {
      commands: [],
      mcpClients: [],
      agents: canUseEvaluationAgentTool(options) ? loadEvalSafeAgents() : [],
    }
  }
  return {
    commands: options.enableSlashCommands ? loadEvalSafeCommands() : [],
    mcpClients: options.enableMcpClients ? loadEvalSafeMcpClients() : [],
    agents: canUseEvaluationAgentTool(options) ? loadEvalSafeAgents() : [],
  }
}

function prependRuntimeToProcessEnv(pythonPath: string): void {
  const runtimeBinDir = dirname(pythonPath)
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existingPath = process.env[pathKey] ?? process.env.PATH ?? process.env.Path ?? ''
  process.env[pathKey] = existingPath
    ? `${runtimeBinDir}${process.platform === 'win32' ? ';' : ':'}${existingPath}`
    : runtimeBinDir
  process.env.VIRTUAL_ENV = dirname(runtimeBinDir)
}

export function configureEvalTaskOutputDir(
  taskRun: Pick<SourceAgentStartInput['taskRun'], 'logsDir'>,
): void {
  setTaskOutputDirOverride(resolve(taskRun.logsDir, 'agent', 'tasks'))
}

function clearMemoizedContext(fn: unknown): void {
  (fn as { cache?: { clear?: () => void } }).cache?.clear?.()
}

export function configureEvalClaudeContextRoot(
  taskRun: Pick<SourceAgentStartInput['taskRun'], 'runDir'>,
): void {
  setOriginalCwd(resolve(taskRun.runDir))
  clearMemoizedContext(getUserContext)
  clearMemoizedContext(getSystemContext)
}

export function configureEvalPythonRuntimeEnv(): void {
  process.env.PYTHONUNBUFFERED = '1'
  process.env.PYTHONDONTWRITEBYTECODE = '1'
}

export function configureEvalAutoCompactEnv(options?: {
  disableAutoCompact?: boolean
}): void {
  if (options?.disableAutoCompact) {
    process.env.DISABLE_AUTO_COMPACT = '1'
    return
  }
  delete process.env.DISABLE_AUTO_COMPACT
}

export function killRunningShellTasksForSession(
  getAppState: () => AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (isLocalShellTask(task) && task.status === 'running') {
      killTask(taskId, setAppState)
    }
  }
}

export class SourceClaudeSessionAgent implements SourceAgentSession {
  private readonly engine: QueryEngine
  private readonly finalizeState: FinalizeSubmissionState
  private readonly taskRun: SourceAgentStartInput['taskRun']
  private readonly getAppState: () => AppState
  private readonly setAppState: (updater: (prev: AppState) => AppState) => void
  private readonly recordContextEvents: boolean
  private disposed = false

  constructor(input: SourceAgentStartInput) {
    validateEvaluationNetworkPolicy(input.contextOptions)
    configureEvalAutoCompactEnv(input.contextOptions)
    enableConfigs()
    setSessionPersistenceDisabled(input.contextOptions?.profile !== 'full-claude-unsafe')
    configureEvalClaudeContextRoot(input.taskRun)
    prependRuntimeToProcessEnv(input.runtime.python)
    configureEvalPythonRuntimeEnv()
    configureEvalTaskOutputDir(input.taskRun)
    const store = createStore(getDefaultAppState())
    this.getAppState = store.getState
    this.setAppState = store.setState
    const finalizeState: FinalizeSubmissionState = {
      readyForJudge: false,
      summary: '',
      files: [],
      pendingEvents: [],
    }
    const finalizeTool = createFinalizeSubmissionTool({
      taskRun: input.taskRun,
      state: finalizeState,
      runtime: input.runtime,
      requireSkillApplication: input.skillOptions?.enabled === true,
      allowedSkillNames: input.skillOptions?.allowedSkillNames,
    })
    if (input.skillOptions?.enabled) {
      setExplicitProjectSkillsDirsForSession([
        resolve(input.skillOptions.skillsDir),
        ...(input.skillOptions.additionalSkillsDirs ?? []).map(dir => resolve(dir)),
      ], {
        allowedSkillNames: input.skillOptions.allowedSkillNames,
        maxSkills: input.skillOptions.maxActiveSkills,
        exclusive: true,
      })
    } else {
      clearExplicitProjectSkillsDirsForSession()
    }
    clearCommandMemoizationCaches()
    const tools = selectSourceToolPool(
      getTools(store.getState().toolPermissionContext),
      finalizeTool,
      {
        enableSkills: input.skillOptions?.enabled ?? false,
        networkPolicy: normalizeEvaluationNetworkPolicy(input.contextOptions?.networkPolicy),
        enableAgentTool: input.contextOptions?.enableAgentTool ?? false,
      },
    )
    this.finalizeState = finalizeState
    this.recordContextEvents = input.contextOptions?.recordContextEvents ?? true
    process.env.CLAUDE_CODE_EVAL_DISABLE_FILE_READ_MALWARE_REMINDER = '1'
    const llmQueryOptions = buildSourceLlmQueryOptions(input.llmOptions)
    const contextConfig = buildQueryEngineContextConfig(input)
    const capabilities = resolveQueryEngineCapabilities(input)
    this.taskRun = input.taskRun
    this.engine = new QueryEngine({
      cwd: input.taskRun.runDir,
      tools,
      commands: capabilities.commands,
      mcpClients: capabilities.mcpClients,
      agents: capabilities.agents,
      canUseTool: createHarnessCanUseTool({
        taskRun: input.taskRun,
        allowedReadRoots: resolveActiveSkillReadRoots(input.skillOptions),
        networkPolicy: normalizeEvaluationNetworkPolicy(input.contextOptions?.networkPolicy),
      }),
      getAppState: store.getState,
      setAppState: store.setState,
      readFileCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      customSystemPrompt: contextConfig.customSystemPrompt,
      appendSystemPrompt: contextConfig.appendSystemPrompt,
      includeSystemContext: contextConfig.includeSystemContext,
      userSpecifiedModel:
        process.env.MODEL_NAME ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      maxTurns: input.maxTurnsPerRound,
      thinkingConfig: llmQueryOptions.thinkingConfig,
      temperatureOverride: llmQueryOptions.temperatureOverride,
      fixedShellCwd: input.taskRun.runDir,
      replayUserMessages: false,
      includeDefaultUserContext: contextConfig.includeDefaultUserContext,
    })
  }

  interrupt(): void {
    this.engine.interrupt()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.engine.interrupt()
    killRunningShellTasksForSession(this.getAppState, this.setAppState)
  }

  async *submit(input: SourceAgentTurnInput) {
    this.finalizeState.readyForJudge = false
    this.finalizeState.summary = ''
    this.finalizeState.files = []
    this.finalizeState.validation = undefined
    this.finalizeState.warnings = undefined
    this.finalizeState.pendingEvents = []
    this.finalizeState.requiredRoundPlan = `workspace/plans/round_${String(input.round).padStart(2, '0')}.md`
    const publicSnapshots = new Map<
      string,
      { command?: unknown; before: PublicSnapshot }
    >()

    for await (const message of this.engine.submitMessage(input.prompt)) {
      for (const event of sourceEventsFromSdkMessage(message)) {
        if (event.type === 'context_event' && !this.recordContextEvents) {
          continue
        }
        if (event.type === 'tool_call' && event.tool === 'Bash' && event.toolUseId) {
          try {
            publicSnapshots.set(event.toolUseId, {
              command:
                event.input && typeof event.input === 'object'
                  ? (event.input as Record<string, unknown>).command
                  : undefined,
              before: await takePublicSnapshot(this.taskRun.publicDir, {
                includeFileContents: true,
              }),
            })
          } catch (error) {
            yield {
              type: 'trajectory_warning' as const,
              code: 'public_integrity_snapshot_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to snapshot public/ before Bash command.',
            }
          }
        }
        yield event
        const drained = drainFinalizeStateEvents(this.finalizeState)
        for (const pendingEvent of drained.events) {
          yield pendingEvent
        }
        if (drained.readyForJudge) {
          return
        }
        if (event.type === 'tool_result' && event.toolUseId) {
          const snapshot = publicSnapshots.get(event.toolUseId)
          if (!snapshot) continue
          publicSnapshots.delete(event.toolUseId)
          try {
            const after = await takePublicSnapshot(this.taskRun.publicDir, {
              includeFileContents: true,
              contentPathFilter: relativePath => snapshot.before.has(relativePath),
            })
            const mutations = diffPublicSnapshots(snapshot.before, after)
            if (mutations.length > 0) {
              let restoreResult: PublicRestoreResult | undefined
              let restoreError: string | undefined
              try {
                restoreResult = await restorePublicSnapshotMutations(
                  this.taskRun.publicDir,
                  snapshot.before,
                  mutations,
                )
              } catch (error) {
                restoreError =
                  error instanceof Error ? error.message : String(error)
              }
              yield {
                type: 'trajectory_warning' as const,
                code: 'public_dir_mutation',
                message:
                  'Bash modified public/ during a source evaluation run; public inputs must remain read-only.',
                details: {
                  toolUseId: event.toolUseId,
                  command: snapshot.command,
                  mutations,
                  restoreResult,
                  restoreError,
                },
              }
            }
          } catch (error) {
            yield {
              type: 'trajectory_warning' as const,
              code: 'public_integrity_check_failed',
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to verify public/ after Bash command.',
            }
          }
        }
      }
    }

    const drained = drainFinalizeStateEvents(this.finalizeState)
    for (const pendingEvent of drained.events) {
      yield pendingEvent
    }
  }
}

export async function createSourceClaudeSessionAgent(
  input: SourceAgentStartInput,
): Promise<SourceAgentSession> {
  return new SourceClaudeSessionAgent(input)
}
