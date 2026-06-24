import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  ablateOracleSkillBundle,
  planOracleSkillAblations,
  runOracleSkillAblationExperiment,
} from './ablate.js'
// NOTE: `generate.ts` transitively imports the full Claude Code QueryEngine,
// which pulls React UI components into the runtime. To keep the lightweight
// commands (`validate`, `render`, `ablate`) usable without the full React
// runtime, we load the author module lazily, only when `generate` or `prompt`
// is invoked.
import {
  loadOracleSkillManifest,
  resolveEnabledOperationIdsFromDropOps,
  validateOracleSkillBundle,
} from './manifest.js'
import { renderOracleSkillVariant } from './render.js'
import type { OracleSkillGenerationMode } from './types.js'
import { HARD_MAX_ORACLE_OPERATIONS } from './limits.js'
import {
  applyEvaluationModelProfile,
  applyGenericEvaluationEnvAliases,
  parseEvaluationModelProfilesConfig,
  validateEvaluationLlmEnvironment,
  type EvaluationModelProfilesConfig,
  type ResolvedEvaluationModelProfile,
} from '../harness/evaluation/configRunner.js'

export type OracleSkillsCliArgs =
  | {
      command: 'generate'
      taskId: string
      tasksDir?: string
      outDir: string
      skillName?: string
      mode?: OracleSkillGenerationMode
      promptOutDir?: string
      maxTurns?: number
      maxOperations?: number
      modelProfile?: string
      modelConfigPath?: string
    }
  | {
      command: 'prompt'
      taskId: string
      tasksDir?: string
      outDir: string
      skillName?: string
      authorWorkspaceDir?: string
      maxOperations?: number
    }
  | {
      command: 'validate'
      bundleDir: string
    }
  | {
      command: 'render'
      bundleDir: string
      outDir: string
      enabledOps?: string[]
      dropOps?: string[]
      variantManifestPath?: string
    }
  | {
      command: 'ablate'
      bundleDir: string
      outDir: string
      dryRun: boolean
      taskId?: string
      tasksDir?: string
      dropOps?: string[]
      modelProfile?: string
      modelConfigPath?: string
    }

function usage(): string {
  return [
    'Usage:',
    '  bun src/oracle-skills/cli.ts generate --task <task_id> --out <bundle_dir> [--tasks-dir tasks] [--skill-name name] [--mode query-engine|template] [--prompt-out dir] [--max-turns n] [--max-operations n] [--model-profile name] [--model-config path]',
    '  bun src/oracle-skills/cli.ts prompt --task <task_id> --out <prompt_dir> [--tasks-dir tasks] [--skill-name name] [--max-operations n]',
    '  bun src/oracle-skills/cli.ts validate --bundle <bundle_dir>',
    '  bun src/oracle-skills/cli.ts render --bundle <bundle_dir> --out <variant_dir> [--enabled-ops op_a,op_b|path|--drop-ops op_a,op_b|path] [--variant-manifest-out path]',
    '  bun src/oracle-skills/cli.ts ablate --bundle <bundle_dir> --out <ablations_dir> [--task <task_id>] [--tasks-dir tasks] [--drop-ops op_a,op_b|path] [--dry-run] [--model-profile name] [--model-config path]',
  ].join('\n')
}

const DEFAULT_MODEL_CONFIG_PATH = 'config/eval-model-profiles.local.json'

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value after ${name}`)
  return value
}

function requireOption(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') throw new Error(`Missing required ${name}`)
  return value
}

function parseMode(value: string | undefined): OracleSkillGenerationMode | undefined {
  if (!value) return undefined
  if (value === 'query-engine' || value === 'template') return value
  throw new Error('--mode must be query-engine or template')
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseMaxOperations(value: string | undefined): number | undefined {
  const parsed = parsePositiveInteger(value, '--max-operations')
  if (parsed !== undefined && parsed > HARD_MAX_ORACLE_OPERATIONS) {
    throw new Error(`--max-operations must be at most ${HARD_MAX_ORACLE_OPERATIONS}`)
  }
  return parsed
}

async function parseOpList(value: string | undefined, flagName: string): Promise<string[] | undefined> {
  if (!value) return undefined
  let raw = value
  if (existsSync(value)) raw = await readFile(value, 'utf8')
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error(`${flagName} JSON must be an array of strings`)
    }
    return parsed.map(item => item.trim()).filter(Boolean)
  }
  return trimmed
    .split(/[,\r\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

async function resolveCliEnabledOperationIds(input: {
  bundleDir: string
  enabledOps?: string[]
  dropOps?: string[]
}): Promise<string[] | undefined> {
  if (input.enabledOps && input.dropOps) {
    throw new Error('--enabled-ops and --drop-ops are mutually exclusive')
  }
  const enabledOperationIds = await parseOpList(input.enabledOps?.[0], '--enabled-ops')
  if (enabledOperationIds) return enabledOperationIds
  const dropOperationIds = await parseOpList(input.dropOps?.[0], '--drop-ops')
  if (!dropOperationIds) return undefined
  const manifest = await loadOracleSkillManifest(input.bundleDir)
  return resolveEnabledOperationIdsFromDropOps(manifest, dropOperationIds)
}

export function parseOracleSkillsCliArgs(args: string[]): OracleSkillsCliArgs {
  const command = args[0]
  if (!command || command === '--help' || command === '-h') {
    throw new Error(usage())
  }
  if (
    command !== 'generate' &&
    command !== 'prompt' &&
    command !== 'validate' &&
    command !== 'render' &&
    command !== 'ablate'
  ) {
    throw new Error(`Unknown oracle-skills command: ${command}\n\n${usage()}`)
  }

  let taskId: string | undefined
  let tasksDir: string | undefined
  let outDir: string | undefined
  let skillName: string | undefined
  let bundleDir: string | undefined
  let enabledOps: string | undefined
  let dropOps: string | undefined
  let mode: string | undefined
  let promptOutDir: string | undefined
  let maxTurns: string | undefined
  let maxOperations: string | undefined
  let modelProfile: string | undefined
  let modelConfigPath: string | undefined
  let variantManifestPath: string | undefined
  let dryRun = false

  for (let index = 1; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--task') {
      taskId = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--tasks-dir') {
      tasksDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--out') {
      outDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--skill-name') {
      skillName = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--mode') {
      mode = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--prompt-out') {
      promptOutDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--max-turns') {
      maxTurns = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--max-operations') {
      maxOperations = readOption(args, index, arg)
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
    if (arg === '--bundle') {
      bundleDir = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--enabled-ops') {
      enabledOps = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--drop-ops') {
      dropOps = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--variant-manifest-out') {
      variantManifestPath = readOption(args, index, arg)
      index++
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (command === 'generate') {
    return {
      command,
      taskId: requireOption(taskId, '--task'),
      tasksDir,
      outDir: requireOption(outDir, '--out'),
      skillName,
      mode: parseMode(mode),
      promptOutDir,
      maxTurns: parsePositiveInteger(maxTurns, '--max-turns'),
      maxOperations: parseMaxOperations(maxOperations),
      modelProfile,
      modelConfigPath,
    }
  }
  if (command === 'prompt') {
    return {
      command,
      taskId: requireOption(taskId, '--task'),
      tasksDir,
      outDir: requireOption(outDir, '--out'),
      skillName,
      maxOperations: parseMaxOperations(maxOperations),
    }
  }
  if (command === 'validate') {
    return {
      command,
      bundleDir: requireOption(bundleDir, '--bundle'),
    }
  }
  if (command === 'render') {
    if (enabledOps && dropOps) throw new Error('--enabled-ops and --drop-ops are mutually exclusive')
    return {
      command,
      bundleDir: requireOption(bundleDir, '--bundle'),
      outDir: requireOption(outDir, '--out'),
      enabledOps: enabledOps ? [enabledOps] : undefined,
      dropOps: dropOps ? [dropOps] : undefined,
      variantManifestPath,
    }
  }
  return {
    command,
    bundleDir: requireOption(bundleDir, '--bundle'),
    outDir: requireOption(outDir, '--out'),
    dryRun,
    ...(taskId ? { taskId } : {}),
    ...(tasksDir ? { tasksDir } : {}),
    ...(dropOps ? { dropOps: [dropOps] } : {}),
    ...(modelProfile ? { modelProfile } : {}),
    ...(modelConfigPath ? { modelConfigPath } : {}),
  }
}

async function loadJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function maybeLoadModelProfiles(
  path: string,
  required: boolean,
): Promise<EvaluationModelProfilesConfig | undefined> {
  if (!existsSync(path)) {
    if (required) throw new Error(`Model profile config not found: ${path}`)
    return undefined
  }
  return parseEvaluationModelProfilesConfig(await loadJsonFile(path))
}

function resolveOracleModelProfile(input: {
  profilesConfig?: EvaluationModelProfilesConfig
  cliModelProfile?: string
}): ResolvedEvaluationModelProfile | undefined {
  const name = input.cliModelProfile ?? input.profilesConfig?.defaultProfile
  if (!name) return undefined
  const profile = input.profilesConfig?.profiles[name]
  if (!profile) throw new Error(`Model profile not found: ${name}`)
  return { ...profile, name }
}

async function configureOracleQueryEngineModel(input: {
  modelProfile?: string
  modelConfigPath?: string
}): Promise<ResolvedEvaluationModelProfile | undefined> {
  const modelConfigPath = input.modelConfigPath ?? DEFAULT_MODEL_CONFIG_PATH
  const profilesConfig = await maybeLoadModelProfiles(
    modelConfigPath,
    Boolean(input.modelProfile),
  )
  const profile = resolveOracleModelProfile({
    profilesConfig,
    cliModelProfile: input.modelProfile,
  })
  if (profile) {
    applyEvaluationModelProfile(profile)
  } else {
    applyGenericEvaluationEnvAliases()
  }
  validateEvaluationLlmEnvironment()
  return profile
}

export async function runOracleSkillsCli(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseOracleSkillsCliArgs(args)
  if (parsed.command === 'generate') {
    if (parsed.mode !== 'template') {
      await configureOracleQueryEngineModel({
        modelProfile: parsed.modelProfile,
        modelConfigPath: parsed.modelConfigPath,
      })
    }
    // Dynamic import keeps the React/QueryEngine dependency tree off the hot
    // path for `validate`, `render`, and `ablate` (which do not need an
    // author LLM session).
    const { generateOracleSkillBundle } = await import('./generate.js')
    const result = await generateOracleSkillBundle({
      taskId: parsed.taskId,
      tasksDir: parsed.tasksDir,
      outDir: parsed.outDir,
      skillName: parsed.skillName,
      mode: parsed.mode,
      promptOutDir: parsed.promptOutDir,
      maxTurns: parsed.maxTurns,
      maxOperations: parsed.maxOperations,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (parsed.command === 'prompt') {
    const { buildOracleSkillAuthorPromptsForTask } = await import('./generate.js')
    const prompts = await buildOracleSkillAuthorPromptsForTask({
      taskId: parsed.taskId,
      tasksDir: parsed.tasksDir,
      outDir: parsed.outDir,
      skillName: parsed.skillName,
      maxOperations: parsed.maxOperations,
    })
    await mkdir(parsed.outDir, { recursive: true })
    const system = join(parsed.outDir, 'author.system.md')
    const user = join(parsed.outDir, 'author.user.md')
    await writeFile(system, prompts.systemPrompt, 'utf8')
    await writeFile(user, prompts.userPrompt, 'utf8')
    process.stdout.write(`${JSON.stringify({ system, user }, null, 2)}\n`)
    return 0
  }
  if (parsed.command === 'validate') {
    const result = await validateOracleSkillBundle(parsed.bundleDir)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  }
  if (parsed.command === 'render') {
    const enabledOperationIds = await parseOpList(parsed.enabledOps?.[0], '--enabled-ops')
    const dropOperationIds = await parseOpList(parsed.dropOps?.[0], '--drop-ops')
    const result = await renderOracleSkillVariant({
      bundleDir: parsed.bundleDir,
      outDir: parsed.outDir,
      enabledOperationIds,
      dropOperationIds,
      variantManifestPath: parsed.variantManifestPath,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  if (parsed.dryRun) {
    const dropOperationIds = await parseOpList(parsed.dropOps?.[0], '--drop-ops')
    const plan = await planOracleSkillAblations({
      bundleDir: parsed.bundleDir,
      dropOperationIds,
    })
    process.stdout.write(`${JSON.stringify({ variants: plan }, null, 2)}\n`)
    return 0
  }
  const dropOperationIds = await parseOpList(parsed.dropOps?.[0], '--drop-ops')
  if (parsed.taskId) {
    const result = await runOracleSkillAblationExperiment({
      bundleDir: parsed.bundleDir,
      outDir: parsed.outDir,
      taskId: parsed.taskId,
      tasksDir: parsed.tasksDir,
      dropOperationIds,
      modelProfile: parsed.modelProfile,
      modelConfigPath: parsed.modelConfigPath,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }
  const result = await ablateOracleSkillBundle({
    bundleDir: parsed.bundleDir,
    outDir: parsed.outDir,
    dropOperationIds,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

if (import.meta.main) {
  let exitCode = 0
  try {
    exitCode = await runOracleSkillsCli()
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
