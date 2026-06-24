import '../harness/evaluation/sourceBootstrap.js'
import { resolve } from 'path'
import { clearCommandMemoizationCaches } from '../commands.js'
import { QueryEngine } from '../QueryEngine.js'
import { getSystemContext, getUserContext } from '../context.js'
import { setOriginalCwd, setSessionPersistenceDisabled } from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { AppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import { isLocalShellTask } from '../tasks/LocalShellTask/guards.js'
import { killTask } from '../tasks/LocalShellTask/killShellTasks.js'
import { getTools } from '../tools.js'
import type { Tools } from '../Tool.js'
import {
  createSyntheticOutputTool,
  SYNTHETIC_OUTPUT_TOOL_NAME,
} from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { enableConfigs } from '../utils/config.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js'
import { sourceEventsFromSdkMessage } from '../harness/evaluation/sdkMessageAdapter.js'
import { createOracleSkillAuthorCanUseTool } from './authorCanUseTool.js'
import type {
  OracleSkillAuthorEvent,
  OracleSkillAuthorSession,
  OracleSkillAuthorSessionFactory,
  OracleSkillAuthorSessionStartInput,
  OracleSkillDraft,
} from './types.js'

const AUTHOR_TOOL_NAMES = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
  SYNTHETIC_OUTPUT_TOOL_NAME,
])

function clearMemoizedContext(fn: unknown): void {
  ;(fn as { cache?: { clear?: () => void } }).cache?.clear?.()
}

function selectAuthorToolPool(baseTools: Tools, structuredOutputTool: Tools[number]): Tools {
  return [
    ...baseTools.filter(tool => AUTHOR_TOOL_NAMES.has(tool.name)),
    structuredOutputTool,
  ]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function structuredOutputFromSdkMessage(message: unknown): unknown {
  const record = asRecord(message)
  return record.type === 'result' ? record.structured_output : undefined
}

export class QueryEngineOracleSkillAuthorSession implements OracleSkillAuthorSession {
  private readonly engine: QueryEngine
  private readonly getAppState: () => AppState
  private readonly setAppState: (updater: (prev: AppState) => AppState) => void
  private disposed = false

  constructor(input: OracleSkillAuthorSessionStartInput) {
    enableConfigs()
    setSessionPersistenceDisabled(true)
    setOriginalCwd(resolve(input.cwd))
    clearMemoizedContext(getUserContext)
    clearMemoizedContext(getSystemContext)
    clearCommandMemoizationCaches()

    const structuredOutputResult = createSyntheticOutputTool(input.jsonSchema)
    if ('error' in structuredOutputResult) {
      throw new Error(`Invalid oracle skill draft schema: ${structuredOutputResult.error}`)
    }

    const store = createStore(getDefaultAppState())
    this.getAppState = store.getState
    this.setAppState = store.setState
    const tools = selectAuthorToolPool(
      getTools(store.getState().toolPermissionContext),
      structuredOutputResult.tool,
    )

    this.engine = new QueryEngine({
      cwd: resolve(input.cwd),
      tools,
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: createOracleSkillAuthorCanUseTool({
        taskDir: input.taskDir,
        authorWorkspaceDir: input.authorWorkspaceDir,
      }),
      getAppState: store.getState,
      setAppState: store.setState,
      readFileCache: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      customSystemPrompt: input.systemPrompt,
      includeDefaultUserContext: false,
      includeSystemContext: false,
      userSpecifiedModel:
        process.env.MODEL_NAME ??
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      maxTurns: input.maxTurns,
      fixedShellCwd: resolve(input.cwd),
      replayUserMessages: false,
      jsonSchema: input.jsonSchema,
    })
  }

  async submit(
    prompt: string,
    options?: {
      onEvent?: (event: OracleSkillAuthorEvent) => Promise<void> | void
    },
  ) {
    const events: OracleSkillAuthorEvent[] = []
    let draft: OracleSkillDraft | undefined
    for await (const message of this.engine.submitMessage(prompt)) {
      const nextEvents = sourceEventsFromSdkMessage(message) as OracleSkillAuthorEvent[]
      for (const event of nextEvents) {
        events.push(event)
        await options?.onEvent?.(event)
      }
      const structured = structuredOutputFromSdkMessage(message)
      if (structured) draft = structured as OracleSkillDraft
    }
    if (!draft) {
      throw new Error('Oracle skill author session did not return StructuredOutput.')
    }
    return { draft, events }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.engine.interrupt()
    const tasks = this.getAppState().tasks ?? {}
    for (const [taskId, task] of Object.entries(tasks)) {
      if (isLocalShellTask(task) && task.status === 'running') {
        killTask(taskId, this.setAppState)
      }
    }
  }
}

export const createQueryEngineOracleSkillAuthorSession: OracleSkillAuthorSessionFactory =
  async input => new QueryEngineOracleSkillAuthorSession(input)
