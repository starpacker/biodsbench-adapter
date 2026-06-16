import './sourceBootstrap.js'
import { dirname } from 'path'
import { QueryEngine } from '../../QueryEngine.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createStore } from '../../state/store.js'
import { getTools } from '../../tools.js'
import type { Tools } from '../../Tool.js'
import { setSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { createFinalizeSubmissionTool, type FinalizeSubmissionState } from './finalizeSubmissionTool.js'
import { createHarnessCanUseTool } from './harnessCanUseTool.js'
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
])

export function selectSourceToolPool(baseTools: Tools, finalizeTool: Tools[number]): Tools {
  return [
    ...baseTools.filter(tool => STANDARD_TOOL_NAMES.has(tool.name)),
    finalizeTool,
  ]
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

function prependRuntimeToProcessEnv(pythonPath: string): void {
  const runtimeBinDir = dirname(pythonPath)
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existingPath = process.env[pathKey] ?? process.env.PATH ?? process.env.Path ?? ''
  process.env[pathKey] = existingPath
    ? `${runtimeBinDir}${process.platform === 'win32' ? ';' : ':'}${existingPath}`
    : runtimeBinDir
  process.env.VIRTUAL_ENV = dirname(runtimeBinDir)
}

export class SourceClaudeSessionAgent implements SourceAgentSession {
  private readonly engine: QueryEngine
  private readonly finalizeState: FinalizeSubmissionState
  private readonly taskRun: SourceAgentStartInput['taskRun']
  private disposed = false

  constructor(input: SourceAgentStartInput) {
    enableConfigs()
    setSessionPersistenceDisabled(true)
    prependRuntimeToProcessEnv(input.runtime.python)
    const store = createStore(getDefaultAppState())
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
    })
    const tools = selectSourceToolPool(
      getTools(store.getState().toolPermissionContext),
      finalizeTool,
    )
    this.finalizeState = finalizeState
    process.env.CLAUDE_CODE_EVAL_DISABLE_FILE_READ_MALWARE_REMINDER = '1'
    const llmQueryOptions = buildSourceLlmQueryOptions(input.llmOptions)
    this.taskRun = input.taskRun
    this.engine = new QueryEngine({
      cwd: input.taskRun.runDir,
      tools,
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: createHarnessCanUseTool({ taskRun: input.taskRun }),
      getAppState: store.getState,
      setAppState: store.setState,
      readFileCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      customSystemPrompt: buildSourceSystemPrompt(input.systemPrompt),
      userSpecifiedModel:
        process.env.MODEL_NAME ??
        process.env.ANTHROPIC_MODEL ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      maxTurns: input.maxTurnsPerRound,
      thinkingConfig: llmQueryOptions.thinkingConfig,
      temperatureOverride: llmQueryOptions.temperatureOverride,
      fixedShellCwd: input.taskRun.runDir,
      replayUserMessages: false,
      includeDefaultUserContext: false,
    })
  }

  interrupt(): void {
    this.engine.interrupt()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.engine.interrupt()
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
