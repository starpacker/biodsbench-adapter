import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { spawn, type ChildProcess } from 'child_process'
import { dirname, join, resolve } from 'path'
import {
  type ProcessLike,
  terminateSpawnedProcessTree,
} from './processTree.js'
import type {
  EvaluationContextOptions,
  EvaluationContextProfile,
  EvaluationNetworkPolicy,
  JudgeFeedbackLevel,
} from './types.js'
import {
  DEFAULT_EVALUATION_NETWORK_POLICY,
  normalizeEvaluationNetworkPolicy,
  validateEvaluationNetworkPolicy,
} from './networkPolicy.js'

export type EvaluationModelProvider = 'anthropic' | 'anthropic-compatible'

export type EvaluationModelProfile = {
  name?: string
  provider: EvaluationModelProvider
  baseUrl?: string
  baseUrlEnv?: string
  apiKey?: string
  apiKeyEnv?: string
  model?: string
  modelEnv?: string
  extraEnv?: Record<string, string>
}

export type ResolvedEvaluationModelProfile = EvaluationModelProfile & {
  name: string
}

export type EvaluationModelProfilesConfig = {
  defaultProfile?: string
  profiles: Record<string, EvaluationModelProfile>
}

export type EvaluationRunnerCondition = {
  name: string
  tasksDir?: string
  runsRoot?: string
  maxRounds?: number
  maxTurnsPerRound?: number
  timeoutSeconds?: number
  concurrency?: number
  workerTimeoutGraceSeconds?: number
  temperature?: number
  thinking?: 'disabled' | 'adaptive'
  judgeFeedbackLevel?: JudgeFeedbackLevel
  systemPrompt?: string
  userPromptPath?: string
  userPromptPaths?: string[]
  knownTaskDeepRead?: boolean
  knownTasks: string[]
  quiet?: boolean
  modelProfile?: string
  contextOptions?: EvaluationRunnerContextOptions
  skills?: EvaluationRunnerSkillOptions
}

export type EvaluationRunnerContextOptions = Partial<EvaluationContextOptions>

export type EvaluationRunnerSkillOptions = {
  enabled: boolean
  skillsDir?: string
  additionalSkillsDirs?: string[]
  skillNames?: string[]
  maxActiveSkills?: number
}

export type EvaluationRunnerConfig = {
  task: string
  tasksDir?: string
  runsRoot?: string
  maxRounds?: number
  maxTurnsPerRound?: number
  timeoutSeconds?: number
  concurrency?: number
  workerTimeoutGraceSeconds?: number
  temperature?: number
  thinking?: 'disabled' | 'adaptive'
  judgeFeedbackLevel?: JudgeFeedbackLevel
  systemPrompt?: string
  userPromptPath?: string
  userPromptPaths?: string[]
  timestampPrefix?: string
  quiet?: boolean
  llm?: {
    profile?: string
    profilesPath?: string
  }
  contextOptions?: EvaluationRunnerContextOptions
  skills?: EvaluationRunnerSkillOptions
  conditions: EvaluationRunnerCondition[]
}

export type EvaluationConfigRunnerArgs = {
  configPath: string
  conditionName?: string
  repeat: number
  modelProfile?: string
  modelConfigPath?: string
  dryRun: boolean
  planJson: boolean
}

export type EvaluationConfigPlanRun = {
  repeatIndex: number
  args: string[]
  displayCommand: string
}

export type EvaluationConfigPlan = {
  condition: string
  repeat: number
  knownTasks: string[]
  knownTaskDeepRead: boolean
  modelProfile?: {
    name: string
    provider: EvaluationModelProvider
    model: string
    baseUrlHost: string | null
  }
  runs: EvaluationConfigPlanRun[]
}

const DEFAULT_MODEL_CONFIG_PATH = 'config/eval-model-profiles.local.json'

function usage(): string {
  return [
    'Usage:',
    '  bun src/harness/evaluation/configRunner.ts --config <path> [options]',
    '',
    'Options:',
    '  --condition <name>        Condition from config.conditions (default: first condition)',
    '  --repeat <n>              Number of repeated runs (default: 1)',
    '  --model-profile <name>    LLM profile name from model config',
    '  --model-config <path>     Model profile config (default: config/eval-model-profiles.local.json)',
    '  --dry-run                 Print the generated plan without running',
    '  --plan-json               Print dry-run output as JSON',
  ].join('\n')
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

function expectString(value: unknown, path: string): string {
  const parsed = expectOptionalString(value, path)
  if (!parsed) throw new Error(`${path} must be a non-empty string`)
  return parsed
}

function expectOptionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  return value
}

function expectOptionalPositiveInteger(value: unknown, path: string): number | undefined {
  const parsed = expectOptionalNumber(value, path)
  if (parsed === undefined) return undefined
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${path} must be a positive integer`)
  }
  return parsed
}

function expectOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function expectOptionalThinking(value: unknown, path: string): 'disabled' | 'adaptive' | undefined {
  const parsed = expectOptionalString(value, path)
  if (parsed === undefined) return undefined
  if (parsed !== 'disabled' && parsed !== 'adaptive') {
    throw new Error(`${path} must be disabled or adaptive, got: ${parsed}`)
  }
  return parsed
}

function expectOptionalJudgeFeedbackLevel(
  value: unknown,
  path: string,
): JudgeFeedbackLevel | undefined {
  const parsed = expectOptionalString(value, path)
  if (parsed === undefined) return undefined
  if (
    parsed !== 'overall_only' &&
    parsed !== 'case_only' &&
    parsed !== 'metric_status' &&
    parsed !== 'metric_value' &&
    parsed !== 'metric_full'
  ) {
    throw new Error(
      `${path} must be overall_only, case_only, metric_status, metric_value, or metric_full, got: ${parsed}`,
    )
  }
  return parsed
}

function expectOptionalContextProfile(
  value: unknown,
  path: string,
): EvaluationContextProfile | undefined {
  const parsed = expectOptionalString(value, path)
  if (parsed === undefined) return undefined
  if (
    parsed !== 'eval-minimal' &&
    parsed !== 'eval-safe-claude-parity' &&
    parsed !== 'full-claude-unsafe'
  ) {
    throw new Error(
      `${path} must be eval-minimal, eval-safe-claude-parity, or full-claude-unsafe, got: ${parsed}`,
    )
  }
  return parsed
}

function expectOptionalNetworkPolicy(
  value: unknown,
  path: string,
): EvaluationNetworkPolicy | undefined {
  const parsed = expectOptionalString(value, path)
  if (parsed === undefined) return undefined
  if (parsed !== 'disabled' && parsed !== 'enabled') {
    throw new Error(`${path} must be disabled or enabled, got: ${parsed}`)
  }
  return parsed
}

function expectStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${path} must be an array of non-empty strings`)
  }
  return value
}

function expectOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return expectStringArray(value, path)
}

function expectOptionalStringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  const raw = expectObject(value, path)
  const parsed: Record<string, string> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!key.trim()) throw new Error(`${path} keys must be non-empty`)
    if (typeof item !== 'string') throw new Error(`${path}.${key} must be a string`)
    parsed[key] = item
  }
  return parsed
}

function parseContextOptions(
  value: unknown,
  path: string,
): EvaluationRunnerContextOptions | undefined {
  if (value === undefined || value === null) return undefined
  const raw = expectObject(value, path)
  const parsed: EvaluationRunnerContextOptions = {}
  const setOptional = <K extends keyof EvaluationRunnerContextOptions>(
    key: K,
    item: EvaluationRunnerContextOptions[K] | undefined,
  ) => {
    if (item !== undefined) parsed[key] = item
  }
  setOptional('profile', expectOptionalContextProfile(raw.profile, `${path}.profile`))
  setOptional('runMemory', expectOptionalBoolean(raw.runMemory, `${path}.runMemory`))
  setOptional('resumeRun', expectOptionalString(raw.resumeRun, `${path}.resumeRun`))
  setOptional(
    'recordContextEvents',
    expectOptionalBoolean(raw.recordContextEvents, `${path}.recordContextEvents`),
  )
  setOptional(
    'reInjectActiveSkillsEachRound',
    expectOptionalBoolean(
      raw.reInjectActiveSkillsEachRound,
      `${path}.reInjectActiveSkillsEachRound`,
    ),
  )
  setOptional(
    'includeClaudeDefaultUserContext',
    expectOptionalBoolean(
      raw.includeClaudeDefaultUserContext,
      `${path}.includeClaudeDefaultUserContext`,
    ),
  )
  setOptional(
    'enableSlashCommands',
    expectOptionalBoolean(raw.enableSlashCommands, `${path}.enableSlashCommands`),
  )
  setOptional(
    'enableMcpClients',
    expectOptionalBoolean(raw.enableMcpClients, `${path}.enableMcpClients`),
  )
  setOptional(
    'networkPolicy',
    expectOptionalNetworkPolicy(raw.networkPolicy, `${path}.networkPolicy`),
  )
  setOptional(
    'enableAgentTool',
    expectOptionalBoolean(raw.enableAgentTool, `${path}.enableAgentTool`),
  )
  setOptional(
    'disableAutoCompact',
    expectOptionalBoolean(raw.disableAutoCompact, `${path}.disableAutoCompact`),
  )
  return parsed
}

function parseSkillOptions(
  value: unknown,
  path: string,
): EvaluationRunnerSkillOptions | undefined {
  if (value === undefined || value === null) return undefined
  const raw = expectObject(value, path)
  const enabled = expectOptionalBoolean(raw.enabled, `${path}.enabled`) ?? false
  const parsed: EvaluationRunnerSkillOptions = {
    enabled,
    skillsDir: expectOptionalString(raw.skillsDir, `${path}.skillsDir`),
    additionalSkillsDirs: expectOptionalStringArray(
      raw.additionalSkillsDirs,
      `${path}.additionalSkillsDirs`,
    ),
    skillNames: expectOptionalStringArray(raw.skillNames, `${path}.skillNames`),
    maxActiveSkills: expectOptionalPositiveInteger(raw.maxActiveSkills, `${path}.maxActiveSkills`),
  }
  if (parsed.enabled && !parsed.skillsDir) {
    throw new Error(`${path}.skillsDir must be set when ${path}.enabled is true`)
  }
  return parsed
}

function parseCondition(rawValue: unknown, path: string): EvaluationRunnerCondition {
  const raw = expectObject(rawValue, path)
  return {
    name: expectString(raw.name, `${path}.name`),
    tasksDir: expectOptionalString(raw.tasksDir, `${path}.tasksDir`),
    runsRoot: expectOptionalString(raw.runsRoot, `${path}.runsRoot`),
    maxRounds: expectOptionalPositiveInteger(raw.maxRounds, `${path}.maxRounds`),
    maxTurnsPerRound: expectOptionalPositiveInteger(raw.maxTurnsPerRound, `${path}.maxTurnsPerRound`),
    timeoutSeconds: expectOptionalPositiveInteger(raw.timeoutSeconds, `${path}.timeoutSeconds`),
    concurrency: expectOptionalPositiveInteger(raw.concurrency, `${path}.concurrency`),
    workerTimeoutGraceSeconds: expectOptionalPositiveInteger(
      raw.workerTimeoutGraceSeconds,
      `${path}.workerTimeoutGraceSeconds`,
    ),
    temperature: expectOptionalNumber(raw.temperature, `${path}.temperature`),
    thinking: expectOptionalThinking(raw.thinking, `${path}.thinking`),
    judgeFeedbackLevel: expectOptionalJudgeFeedbackLevel(
      raw.judgeFeedbackLevel,
      `${path}.judgeFeedbackLevel`,
    ),
    systemPrompt: expectOptionalString(raw.systemPrompt, `${path}.systemPrompt`),
    userPromptPath: expectOptionalString(raw.userPromptPath, `${path}.userPromptPath`),
    userPromptPaths: expectOptionalStringArray(raw.userPromptPaths, `${path}.userPromptPaths`),
    knownTaskDeepRead: expectOptionalBoolean(raw.knownTaskDeepRead, `${path}.knownTaskDeepRead`),
    knownTasks: expectStringArray(raw.knownTasks, `${path}.knownTasks`),
    quiet: expectOptionalBoolean(raw.quiet, `${path}.quiet`),
    modelProfile: expectOptionalString(raw.modelProfile, `${path}.modelProfile`),
    contextOptions: parseContextOptions(raw.contextOptions, `${path}.contextOptions`),
    skills: parseSkillOptions(raw.skills, `${path}.skills`),
  }
}

export function parseEvaluationRunnerConfig(rawValue: unknown): EvaluationRunnerConfig {
  const raw = expectObject(rawValue, 'config')
  const llm =
    raw.llm === undefined || raw.llm === null
      ? undefined
      : (() => {
          const rawLlm = expectObject(raw.llm, 'llm')
          return {
            profile: expectOptionalString(rawLlm.profile, 'llm.profile'),
            profilesPath: expectOptionalString(rawLlm.profilesPath, 'llm.profilesPath'),
          }
        })()
  const rawConditions = raw.conditions === undefined ? [{ name: 'default' }] : raw.conditions
  if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
    throw new Error('config.conditions must be a non-empty array when provided')
  }
  return {
    task: expectString(raw.task, 'task'),
    tasksDir: expectOptionalString(raw.tasksDir, 'tasksDir'),
    runsRoot: expectOptionalString(raw.runsRoot, 'runsRoot'),
    maxRounds: expectOptionalPositiveInteger(raw.maxRounds, 'maxRounds'),
    maxTurnsPerRound: expectOptionalPositiveInteger(raw.maxTurnsPerRound, 'maxTurnsPerRound'),
    timeoutSeconds: expectOptionalPositiveInteger(raw.timeoutSeconds, 'timeoutSeconds'),
    concurrency: expectOptionalPositiveInteger(raw.concurrency, 'concurrency'),
    workerTimeoutGraceSeconds: expectOptionalPositiveInteger(
      raw.workerTimeoutGraceSeconds,
      'workerTimeoutGraceSeconds',
    ),
    temperature: expectOptionalNumber(raw.temperature, 'temperature'),
    thinking: expectOptionalThinking(raw.thinking, 'thinking'),
    judgeFeedbackLevel: expectOptionalJudgeFeedbackLevel(
      raw.judgeFeedbackLevel,
      'judgeFeedbackLevel',
    ),
    systemPrompt: expectOptionalString(raw.systemPrompt, 'systemPrompt'),
    userPromptPath: expectOptionalString(raw.userPromptPath, 'userPromptPath'),
    userPromptPaths: expectOptionalStringArray(raw.userPromptPaths, 'userPromptPaths'),
    timestampPrefix: expectOptionalString(raw.timestampPrefix, 'timestampPrefix'),
    quiet: expectOptionalBoolean(raw.quiet, 'quiet'),
    llm,
    contextOptions: parseContextOptions(raw.contextOptions, 'contextOptions'),
    skills: parseSkillOptions(raw.skills, 'skills'),
    conditions: rawConditions.map((condition, index) => parseCondition(condition, `conditions[${index}]`)),
  }
}

function parseModelProfile(rawValue: unknown, path: string): EvaluationModelProfile {
  const raw = expectObject(rawValue, path)
  const provider = expectString(raw.provider, `${path}.provider`)
  if (provider !== 'anthropic' && provider !== 'anthropic-compatible') {
    throw new Error(`${path}.provider must be anthropic or anthropic-compatible, got: ${provider}`)
  }
  return {
    provider,
    baseUrl: expectOptionalString(raw.baseUrl, `${path}.baseUrl`),
    baseUrlEnv: expectOptionalString(raw.baseUrlEnv, `${path}.baseUrlEnv`),
    apiKey: expectOptionalString(raw.apiKey, `${path}.apiKey`),
    apiKeyEnv: expectOptionalString(raw.apiKeyEnv, `${path}.apiKeyEnv`),
    model: expectOptionalString(raw.model, `${path}.model`),
    modelEnv: expectOptionalString(raw.modelEnv, `${path}.modelEnv`),
    extraEnv: expectOptionalStringRecord(raw.extraEnv, `${path}.extraEnv`),
  }
}

export function parseEvaluationModelProfilesConfig(rawValue: unknown): EvaluationModelProfilesConfig {
  const raw = expectObject(rawValue, 'modelConfig')
  const profiles = expectObject(raw.profiles, 'profiles')
  const parsedProfiles: Record<string, EvaluationModelProfile> = {}
  for (const [name, profile] of Object.entries(profiles)) {
    if (!name.trim()) throw new Error('profiles keys must be non-empty')
    parsedProfiles[name] = parseModelProfile(profile, `profiles.${name}`)
  }
  return {
    defaultProfile: expectOptionalString(raw.defaultProfile, 'defaultProfile'),
    profiles: parsedProfiles,
  }
}

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value after ${name}`)
  return value
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`)
  }
  return parsed
}

export function parseEvaluationConfigRunnerArgs(args: string[]): EvaluationConfigRunnerArgs {
  let configPath = ''
  let conditionName: string | undefined
  let repeat = 1
  let modelProfile: string | undefined
  let modelConfigPath: string | undefined
  let dryRun = false
  let planJson = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') throw new Error(usage())
    if (arg === '--config') {
      configPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--condition') {
      conditionName = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--repeat') {
      repeat = parsePositiveInteger(readOption(args, index, arg), arg)
      index++
      continue
    }
    if (arg === '--model-profile') {
      modelProfile = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--model-config') {
      modelConfigPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--plan-json') {
      planJson = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!configPath) throw new Error(`Missing required --config.\n\n${usage()}`)
  if (planJson) dryRun = true
  return { configPath, conditionName, repeat, modelProfile, modelConfigPath, dryRun, planJson }
}

function findCondition(config: EvaluationRunnerConfig, name?: string): EvaluationRunnerCondition {
  const conditionName = name || config.conditions[0]?.name
  const condition = config.conditions.find(item => item.name === conditionName)
  if (!condition) throw new Error(`Condition not found: ${conditionName}`)
  return condition
}

function configValue<T>(
  config: EvaluationRunnerConfig,
  condition: EvaluationRunnerCondition,
  name: keyof EvaluationRunnerConfig & keyof EvaluationRunnerCondition,
  fallback: T,
): T {
  const conditionValue = condition[name]
  if (conditionValue !== undefined && conditionValue !== null) return conditionValue as T
  const configValue = config[name]
  if (configValue !== undefined && configValue !== null) return configValue as T
  return fallback
}

function joinPosixPath(parts: string[]): string {
  return parts
    .map(part => part.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

const SOLVER_FACING_ABLATION_LEAK_PATTERNS = [
  { name: 'drop marker', pattern: /(?:^|[\\/_-])drop[_-]/i },
  { name: 'operation id', pattern: /(?:^|[\\/_-])op_[0-9]{3}[A-Za-z0-9_-]*\b/i },
  { name: 'enabled_ops metadata', pattern: /\benabled_ops\b/i },
  { name: 'disabled_ops metadata', pattern: /\bdisabled_ops\b/i },
  { name: 'disabled_by_request metadata', pattern: /\bdisabled_by_request\b/i },
  {
    name: 'compact operation index set',
    pattern: /(?:^|[\\/_-])(?:0?[3-9][0-9]|1[0-9]{2})(?:[_-]?(?:0?[3-9][0-9]|1[0-9]{2})){1,}(?:$|[\\/_-])/i,
  },
]

function assertNoSolverFacingAblationLeak(
  field: string,
  value: string,
  options: { allowTimestampNumberGroups?: boolean } = {},
): void {
  const patterns = options.allowTimestampNumberGroups
    ? SOLVER_FACING_ABLATION_LEAK_PATTERNS.filter(item => item.name !== 'compact operation index set')
    : SOLVER_FACING_ABLATION_LEAK_PATTERNS
  const leak = patterns.find(item => item.pattern.test(value))
  if (!leak) return
  throw new Error(`solver-facing ablation leak in ${field}: ${leak.name} matched "${value}"`)
}

function assertGeneratedEvaluationArgsDoNotLeakAblation(args: string[]): void {
  args.forEach((value, index) => {
    assertNoSolverFacingAblationLeak(`generated arg[${index}]`, value, {
      // The timestamp arg includes date/time digits and can accidentally look
      // like compact op indexes (for example HHMMSS = 183036). Still check it
      // for explicit leak tokens such as drop_ or op_###.
      allowTimestampNumberGroups: index > 0 && args[index - 1] === '--timestamp',
    })
  })
}

function addOption(args: string[], name: string, value: unknown): void {
  if (value === undefined || value === null || `${value}` === '') return
  args.push(name, `${value}`)
}

function pushContextOptions(
  args: string[],
  options: EvaluationRunnerContextOptions | undefined,
): void {
  if (!options) return
  addOption(
    args,
    '--network-policy',
    normalizeEvaluationNetworkPolicy(options.networkPolicy),
  )
  if (options.profile && options.profile !== 'eval-minimal') {
    addOption(args, '--context-profile', options.profile)
  }
  if (options.runMemory) args.push('--enable-run-memory')
  addOption(args, '--resume-run', options.resumeRun)
  if (options.recordContextEvents === false) args.push('--disable-context-events')
  if (options.reInjectActiveSkillsEachRound === false) args.push('--disable-skill-reinject')
  if (options.includeClaudeDefaultUserContext) {
    args.push('--include-claude-default-user-context')
  }
  if (options.enableSlashCommands) args.push('--enable-slash-commands')
  if (options.enableMcpClients) args.push('--enable-mcp')
  if (options.enableAgentTool === true) args.push('--enable-agent-tool')
  if (options.enableAgentTool === false) args.push('--disable-agent-tool')
  if (options.disableAutoCompact) args.push('--disable-auto-compact')
}

function pushSkillOptions(args: string[], options: EvaluationRunnerSkillOptions | undefined): void {
  if (!options?.enabled) return
  args.push('--enable-skills')
  addOption(args, '--skills-dir', options.skillsDir)
  for (const dir of options.additionalSkillsDirs ?? []) {
    addOption(args, '--skills-dir', dir)
  }
  for (const name of options.skillNames ?? []) {
    addOption(args, '--skill-name', name)
  }
  addOption(args, '--max-active-skills', options.maxActiveSkills)
}

function combinedUserPromptPaths(
  config: EvaluationRunnerConfig,
  condition: EvaluationRunnerCondition,
): string[] {
  return [
    ...(config.userPromptPath ? [config.userPromptPath] : []),
    ...(config.userPromptPaths ?? []),
    ...(condition.userPromptPath ? [condition.userPromptPath] : []),
    ...(condition.userPromptPaths ?? []),
  ]
}

function resolveSkillOptions(
  config: EvaluationRunnerConfig,
  condition: EvaluationRunnerCondition,
): EvaluationRunnerSkillOptions | undefined {
  return condition.skills ?? config.skills
}

function resolveContextOptions(
  config: EvaluationRunnerConfig,
  condition: EvaluationRunnerCondition,
): EvaluationRunnerContextOptions {
  return {
    networkPolicy: DEFAULT_EVALUATION_NETWORK_POLICY,
    ...config.contextOptions,
    ...condition.contextOptions,
  }
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function bunDisplayName(): string {
  const executable = process.execPath.replace(/\\/g, '/')
  return executable.endsWith('/bun') || executable.endsWith('/bun.exe') ? 'bun' : process.execPath
}

function formatDisplayCommand(args: string[]): string {
  return [bunDisplayName(), ...args].map(quoteArg).join(' ')
}

export function buildEvaluationConfigPlan(input: {
  config: EvaluationRunnerConfig
  conditionName?: string
  repeat: number
  timestamp: string
  modelProfile?: {
    name: string
    provider: EvaluationModelProvider
    model: string
    baseUrlHost: string | null
  }
}): EvaluationConfigPlan {
  if (!Number.isInteger(input.repeat) || input.repeat <= 0) {
    throw new Error(`repeat must be a positive integer, got: ${input.repeat}`)
  }
  const condition = findCondition(input.config, input.conditionName)
  const runsRoot = configValue(input.config, condition, 'runsRoot', 'output/known-task-materials')
  const knownTasks = condition.knownTasks.filter(taskId => taskId.trim())
  const knownTaskDeepRead = Boolean(
    condition.knownTaskDeepRead ?? false,
  )
  const contextOptions = resolveContextOptions(input.config, condition)
  validateEvaluationNetworkPolicy(contextOptions)
  const skillOptions = resolveSkillOptions(input.config, condition)
  const runs: EvaluationConfigPlanRun[] = []

  for (let repeatIndex = 1; repeatIndex <= input.repeat; repeatIndex++) {
    const runsDirParts = [runsRoot, condition.name]
    if (input.repeat > 1) runsDirParts.push(`repeat_${repeatIndex.toString().padStart(2, '0')}`)
    const args = ['src/harness/evaluation/cli.ts', '--task', input.config.task]
    addOption(args, '--tasks-dir', configValue(input.config, condition, 'tasksDir', 'tasks'))
    addOption(args, '--runs-dir', joinPosixPath(runsDirParts))
    addOption(args, '--max-rounds', configValue(input.config, condition, 'maxRounds', 5))
    addOption(args, '--max-turns-per-round', configValue(input.config, condition, 'maxTurnsPerRound', undefined))
    addOption(args, '--timeout-seconds', configValue(input.config, condition, 'timeoutSeconds', 7200))
    addOption(args, '--judge-feedback-level', configValue(input.config, condition, 'judgeFeedbackLevel', undefined))
    addOption(args, '--concurrency', configValue(input.config, condition, 'concurrency', undefined))
    addOption(
      args,
      '--worker-timeout-grace-seconds',
      configValue(input.config, condition, 'workerTimeoutGraceSeconds', undefined),
    )
    addOption(args, '--temperature', configValue(input.config, condition, 'temperature', 1))
    addOption(args, '--thinking', configValue(input.config, condition, 'thinking', 'disabled'))
    addOption(args, '--system-prompt', configValue(input.config, condition, 'systemPrompt', undefined))
    for (const userPromptPath of combinedUserPromptPaths(input.config, condition)) {
      addOption(args, '--user-prompt', userPromptPath)
    }
    addOption(args, '--timestamp', `${input.timestamp}_${repeatIndex.toString().padStart(2, '0')}`)
    for (const knownTask of knownTasks) {
      args.push('--known-task', knownTask)
    }
    if (knownTaskDeepRead) args.push('--known-task-deep-read')
    pushContextOptions(args, contextOptions)
    pushSkillOptions(args, skillOptions)
    if (configValue(input.config, condition, 'quiet', false)) args.push('--quiet')
    assertGeneratedEvaluationArgsDoNotLeakAblation(args)
    runs.push({
      repeatIndex,
      args,
      displayCommand: formatDisplayCommand(args),
    })
  }

  return {
    condition: condition.name,
    repeat: input.repeat,
    knownTasks,
    knownTaskDeepRead,
    modelProfile: input.modelProfile,
    runs,
  }
}

function envValue(env: Record<string, string | undefined>, name: string | undefined): string | undefined {
  if (!name) return undefined
  const value = env[name]
  return value && value.trim() ? value : undefined
}

function setEnv(env: Record<string, string | undefined>, name: string, value: string | undefined): void {
  if (value === undefined) {
    delete env[name]
  } else {
    env[name] = value
  }
}

export function applyGenericEvaluationEnvAliases(env: Record<string, string | undefined> = process.env): void {
  if (envValue(env, 'API_KEY')) setEnv(env, 'ANTHROPIC_API_KEY', envValue(env, 'API_KEY'))
  if (envValue(env, 'BASE_URL')) setEnv(env, 'ANTHROPIC_BASE_URL', envValue(env, 'BASE_URL'))
  if (envValue(env, 'MODEL_NAME')) {
    setEnv(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', envValue(env, 'MODEL_NAME'))
    setEnv(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', envValue(env, 'MODEL_NAME'))
  }
}

export function applyEvaluationModelProfile(
  profile: ResolvedEvaluationModelProfile,
  env: Record<string, string | undefined> = process.env,
): void {
  const apiKey =
    profile.apiKey ??
    envValue(env, profile.apiKeyEnv) ??
    envValue(env, 'API_KEY') ??
    envValue(env, 'ANTHROPIC_API_KEY')
  const model =
    profile.model ??
    envValue(env, profile.modelEnv) ??
    envValue(env, 'MODEL_NAME') ??
    envValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ??
    envValue(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')
  const baseUrl = profile.baseUrl ?? envValue(env, profile.baseUrlEnv)

  if (!apiKey) {
    throw new Error(`Model profile ${profile.name} is missing apiKey or apiKeyEnv`)
  }
  if (!model) {
    throw new Error(`Model profile ${profile.name} is missing model or modelEnv`)
  }
  if (profile.provider === 'anthropic-compatible' && !baseUrl) {
    throw new Error(`Model profile ${profile.name} requires baseUrl or baseUrlEnv`)
  }

  setEnv(env, 'API_KEY', apiKey)
  setEnv(env, 'MODEL_NAME', model)
  setEnv(env, 'GATEWAY_PROTOCOL', 'anthropic')
  setEnv(env, 'ANTHROPIC_API_KEY', apiKey)
  setEnv(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', model)
  setEnv(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', model)
  setEnv(env, 'BASE_URL', baseUrl)
  setEnv(env, 'ANTHROPIC_BASE_URL', baseUrl)

  for (const [name, value] of Object.entries(profile.extraEnv ?? {})) {
    setEnv(env, name, value)
  }
}

function parseBaseUrlHost(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).host
  } catch {
    try {
      return new URL(`https://${value}`).host
    } catch {
      return null
    }
  }
}

function modelProfileSummary(
  profile: ResolvedEvaluationModelProfile | undefined,
  env: Record<string, string | undefined> = process.env,
): EvaluationConfigPlan['modelProfile'] {
  if (!profile) return undefined
  return {
    name: profile.name,
    provider: profile.provider,
    model:
      profile.model ??
      envValue(env, profile.modelEnv) ??
      envValue(env, 'MODEL_NAME') ??
      envValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ??
      '',
    baseUrlHost: parseBaseUrlHost(profile.baseUrl ?? envValue(env, profile.baseUrlEnv)),
  }
}

export function resolveEvaluationModelProfile(input: {
  config: EvaluationRunnerConfig
  conditionName?: string
  cliModelProfile?: string
  profilesConfig?: EvaluationModelProfilesConfig
}): ResolvedEvaluationModelProfile | undefined {
  const condition = findCondition(input.config, input.conditionName)
  const name =
    input.cliModelProfile ??
    condition.modelProfile ??
    input.config.llm?.profile ??
    input.profilesConfig?.defaultProfile
  if (!name) return undefined
  const profile = input.profilesConfig?.profiles[name]
  if (!profile) throw new Error(`Model profile not found: ${name}`)
  return { ...profile, name }
}

export function validateEvaluationLlmEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  const missing: string[] = []
  if (!envValue(env, 'ANTHROPIC_API_KEY') && !envValue(env, 'API_KEY')) {
    missing.push('ANTHROPIC_API_KEY or API_KEY')
  }
  if (
    !envValue(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL') &&
    !envValue(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL') &&
    !envValue(env, 'MODEL_NAME')
  ) {
    missing.push('ANTHROPIC_DEFAULT_SONNET_MODEL/ANTHROPIC_DEFAULT_OPUS_MODEL or MODEL_NAME')
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing LLM environment: ${missing.join(', ')}. ` +
        `Use --model-profile with ${DEFAULT_MODEL_CONFIG_PATH}, or set the environment explicitly.`,
    )
  }
}

async function loadJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function maybeLoadModelProfiles(path: string, required: boolean): Promise<EvaluationModelProfilesConfig | undefined> {
  if (!existsSync(path)) {
    if (required) throw new Error(`Model profile config not found: ${path}`)
    return undefined
  }
  return parseEvaluationModelProfilesConfig(await loadJsonFile(path))
}

function makeTimestamp(prefix: string, conditionName: string): string {
  const now = new Date()
  const pad = (value: number) => value.toString().padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}_${conditionName}_${stamp}`
}

export type RunProcessOptions = {
  timeoutMs?: number
  killGraceMs?: number
  spawnProcess?: (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => ProcessLike & Pick<ChildProcess, 'on'>
  terminateProcessTree?: (child: ProcessLike, signal: NodeJS.Signals) => void
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  if (signal === 'SIGHUP') return 129
  return 1
}

export function runProcess(
  args: string[],
  cwd: string,
  options: RunProcessOptions = {},
): Promise<number> {
  return new Promise(resolveExit => {
    const child = (options.spawnProcess ?? spawn)(process.execPath, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })
    const terminate = options.terminateProcessTree ?? terminateSpawnedProcessTree
    const killGraceMs = options.killGraceMs ?? 5000
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    let terminating = false
    let timedOut = false
    let interruptedBySignal: NodeJS.Signals | undefined
    const signalHandlers = new Map<NodeJS.Signals, () => void>()

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler)
      }
      signalHandlers.clear()
    }
    const finish = (code: number) => {
      if (finished) return
      finished = true
      cleanup()
      resolveExit(code)
    }
    const terminateWithEscalation = (
      signal: NodeJS.Signals,
      finalCode: number,
    ) => {
      if (terminating || finished) return
      terminating = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      terminate(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        terminate(child, 'SIGKILL')
        finish(finalCode)
      }, killGraceMs)
      if (signal !== 'SIGTERM') {
        process.stderr.write(`[eval-config] received ${signal}; terminating child process tree\n`)
      }
    }

    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        if (finished || terminating) return
        timedOut = true
        process.stderr.write(`[eval-config] child process watchdog timed out after ${options.timeoutMs}ms\n`)
        terminateWithEscalation('SIGTERM', 124)
      }, options.timeoutMs)
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
      const handler = () => {
        if (finished || terminating || interruptedBySignal) return
        interruptedBySignal = signal
        terminateWithEscalation(signal, exitCodeForSignal(signal))
      }
      signalHandlers.set(signal, handler)
      process.once(signal, handler)
    }

    child.on('error', error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      finish(1)
    })
    child.on('exit', code => {
      if (interruptedBySignal) {
        finish(exitCodeForSignal(interruptedBySignal))
      } else if (timedOut) {
        finish(124)
      } else {
        finish(code ?? 1)
      }
    })
  })
}

function findEvaluationRepoRoot(start: string): string | undefined {
  let current = resolve(start)
  while (true) {
    if (
      existsSync(join(current, 'tsconfig.json')) &&
      existsSync(join(current, 'src', 'harness', 'evaluation', 'cli.ts'))
    ) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function resolveEvaluationConfigRepoRoot(configPath: string): string {
  return (
    findEvaluationRepoRoot(process.cwd()) ??
    findEvaluationRepoRoot(dirname(resolve(configPath))) ??
    resolve(dirname(resolve(configPath)), '..')
  )
}

export async function runEvaluationConfigRunner(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseEvaluationConfigRunnerArgs(args)
  const configPath = resolve(parsed.configPath)
  const repoRoot = resolveEvaluationConfigRepoRoot(configPath)
  const config = parseEvaluationRunnerConfig(await loadJsonFile(configPath))
  const condition = findCondition(config, parsed.conditionName)
  const modelConfigPath = resolve(parsed.modelConfigPath ?? config.llm?.profilesPath ?? DEFAULT_MODEL_CONFIG_PATH)
  const profileNameRequested = Boolean(parsed.modelProfile ?? condition.modelProfile ?? config.llm?.profile)
  const profilesConfig = await maybeLoadModelProfiles(modelConfigPath, profileNameRequested)
  const profile = resolveEvaluationModelProfile({
    config,
    conditionName: parsed.conditionName,
    cliModelProfile: parsed.modelProfile,
    profilesConfig,
  })

  if (profile) {
    applyEvaluationModelProfile(profile)
  } else {
    applyGenericEvaluationEnvAliases()
  }
  if (!parsed.dryRun) validateEvaluationLlmEnvironment()

  const timestamp = makeTimestamp(config.timestampPrefix ?? 'known_task_materials', condition.name)
  const plan = buildEvaluationConfigPlan({
    config,
    conditionName: condition.name,
    repeat: parsed.repeat,
    timestamp,
    modelProfile: modelProfileSummary(profile),
  })

  if (parsed.dryRun) {
    if (parsed.planJson) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    } else {
      process.stdout.write(`[dry-run] condition ${plan.condition}, repeat ${plan.repeat}\n`)
      for (const run of plan.runs) process.stdout.write(`${run.displayCommand}\n`)
    }
    return 0
  }

  for (const run of plan.runs) {
    process.stderr.write(`[eval-config] ${run.repeatIndex}/${plan.repeat}: ${run.displayCommand}\n`)
    const timeoutSeconds = configValue(config, condition, 'timeoutSeconds', 7200)
    const graceSeconds = configValue(config, condition, 'workerTimeoutGraceSeconds', 60)
    const code = await runProcess(run.args, repoRoot, {
      timeoutMs: (timeoutSeconds + graceSeconds) * 1000,
    })
    if (code !== 0) return code
  }
  return 0
}

if (import.meta.main) {
  let exitCode = 0
  try {
    exitCode = await runEvaluationConfigRunner()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Usage:')) {
      process.stdout.write(`${message}\n`)
      exitCode = 0
    } else {
      process.stderr.write(`${message}\n`)
      exitCode = 1
    }
  }
  process.exit(exitCode)
}
