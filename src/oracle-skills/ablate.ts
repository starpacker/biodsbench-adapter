import { createHash } from 'crypto'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'path'
import {
  runEvaluationConfigRunner,
  type EvaluationRunnerConfig,
} from '../harness/evaluation/configRunner.js'
import {
  assertOracleSkillBundleValid,
  defaultEnabledOperationIds,
  resolveEnabledOperationIdsFromDropOps,
} from './manifest.js'
import { renderOracleSkillVariant } from './render.js'
import type {
  AblateOracleSkillBundleInput,
  AblateOracleSkillBundleResult,
  AblationVariant,
  OracleSkillAblationPlanVariant,
  OracleSkillAblationVariantKind,
  OracleSkillManifest,
  VariantManifest,
} from './types.js'

function isInside(path: string, parent: string): boolean {
  const child = resolve(path)
  const base = resolve(parent)
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base
  return normalizedChild === normalizedBase || normalizedChild.startsWith(`${normalizedBase}${process.platform === 'win32' ? '\\' : '/'}`)
}

function assertSafeOutputRoot(outDir: string, bundleDir: string): void {
  const resolved = resolve(outDir)
  if (resolved === parse(resolved).root) {
    throw new Error(`Refusing to write oracle ablations at filesystem root: ${outDir}`)
  }
  if (isInside(bundleDir, outDir)) {
    throw new Error('Refusing to write oracle ablations over the source bundle')
  }
}

function operationDeletionOrder(manifest: OracleSkillManifest): string[] {
  return [...manifest.operations]
    .filter(op => op.enabled_by_default)
    .sort((a, b) => {
      const priority = b.ablation_priority - a.ablation_priority
      return priority !== 0 ? priority : a.id.localeCompare(b.id)
    })
    .map(op => op.id)
}

function stateKey(operationIds: string[]): string {
  return operationIds.join('|')
}

export function anonymizedOracleVariantName(
  enabledOperationIds: string[],
  namespace = 'state',
): string {
  const hash = createHash('sha256')
    .update(`${namespace}\n${stateKey(enabledOperationIds) || '<no-enabled-operations>'}`)
    .digest('hex')
    .slice(0, 12)
  return `v_${hash}`
}

function ablationVariant(input: {
  semanticName: string
  kind: OracleSkillAblationVariantKind
  enabledOperationIds: string[]
  namespace: string
  drop_op?: string
  drop_ops?: string[]
  step?: number
}): OracleSkillAblationPlanVariant {
  return {
    name: anonymizedOracleVariantName(input.enabledOperationIds, input.namespace),
    semanticName: input.semanticName,
    kind: input.kind,
    drop_op: input.drop_op,
    drop_ops: input.drop_ops,
    step: input.step,
    enabledOperationIds: input.enabledOperationIds,
  }
}

export function applyPriorityGreedyAblationRecord(
  acceptedDropOps: string[],
  record: { drop_op?: string | null; result_type?: string | null },
): { accepted: boolean; acceptedDropOps: string[] } {
  if (record.result_type === 'pass' && record.drop_op) {
    return {
      accepted: true,
      acceptedDropOps: [...acceptedDropOps, record.drop_op],
    }
  }
  return {
    accepted: false,
    acceptedDropOps: [...acceptedDropOps],
  }
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

type AblationRunOptions = {
  taskId: string
  tasksDir?: string
  modelProfile?: string
  modelConfigPath?: string
  maxRounds?: number
  timeoutSeconds?: number
}

type AblationRunRecord = {
  index: number
  variant: string
  mode: 'baseline' | 'priority_greedy' | 'fixed_drop'
  drop_op?: string
  drop_ops: string[]
  parent_drop_ops: string[]
  result_type: 'pass' | 'valid_fail' | 'inconclusive'
  ok: boolean
  reason: string
  accepted: boolean
  exit_code: number
  pollution_findings: string[]
  variant_dir: string
  variant_metadata_path: string
  config_path: string
  run_summary_path?: string
  enabled_ops: string[]
  disabled_ops: VariantManifest['disabled_ops']
  reward?: unknown
  final_status?: unknown
}

export type RunOracleSkillAblationExperimentInput = AblationRunOptions & {
  bundleDir: string
  outDir: string
  dropOperationIds?: string[]
}

export type RunOracleSkillAblationExperimentResult = {
  bundleDir: string
  outDir: string
  status: string
  mode: 'priority_greedy' | 'fixed_drop'
  accepted_drop_ops: string[]
  records: AblationRunRecord[]
}

function makeAblationEvalConfig(input: {
  taskId: string
  tasksDir?: string
  runsRoot: string
  skillsDir: string
  skillName: string
  modelProfile?: string
  modelConfigPath?: string
  maxRounds?: number
  timeoutSeconds?: number
}): EvaluationRunnerConfig {
  return {
    task: input.taskId,
    tasksDir: input.tasksDir ?? 'tasks',
    runsRoot: input.runsRoot,
    maxRounds: input.maxRounds ?? 5,
    timeoutSeconds: input.timeoutSeconds ?? 7200,
    temperature: 1,
    thinking: 'disabled',
    judgeFeedbackLevel: 'metric_full',
    timestampPrefix: 'oracle_skill_ablation_run',
    ...(input.modelProfile || input.modelConfigPath
      ? {
          llm: {
            ...(input.modelProfile ? { profile: input.modelProfile } : {}),
            ...(input.modelConfigPath ? { profilesPath: input.modelConfigPath } : {}),
          },
        }
      : {}),
    contextOptions: {
      networkPolicy: 'disabled',
      enableAgentTool: false,
    },
    skills: {
      enabled: true,
      skillsDir: input.skillsDir,
      skillNames: [input.skillName],
      maxActiveSkills: 1,
    },
    conditions: [{ name: 'run', knownTasks: [] }],
  }
}

function evalConfigPathValue(path: string): string {
  const rel = relative(process.cwd(), path)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/')
  return path.replace(/\\/g, '/')
}

async function latestRunSummaryPath(runsRoot: string, taskId: string): Promise<string | undefined> {
  const runRoot = join(runsRoot, 'run')
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(runRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${taskId}_`)) continue
    const path = join(runRoot, entry.name, 'logs', 'run_summary.json')
    try {
      candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs })
    } catch {
      // Ignore incomplete run directories.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.path
}

async function readJsonIfExists(path: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!path) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function scanTrajectoryForNetwork(path: string | undefined): Promise<string[]> {
  if (!path) return ['missing_trajectory_for_clean_check']
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return ['missing_trajectory_for_clean_check']
  }
  const findings: string[] = []
  const forbiddenTools = new Set(['WebSearch', 'WebFetch'])
  const networkCommand = /\b(curl|wget|ssh|scp|rsync)\b/
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.kind !== 'tool_call') continue
    const tool = String(event.tool ?? '')
    if (forbiddenTools.has(tool) || tool.startsWith('CompatWebSearch') || tool.startsWith('CompatWebFetch')) {
      findings.push(`${path}:${index + 1}: forbidden tool ${tool}`)
      continue
    }
    if (tool === 'Bash') {
      const input = event.input as Record<string, unknown> | undefined
      const command = String(input?.command ?? '')
      if (networkCommand.test(command)) findings.push(`${path}:${index + 1}: forbidden Bash network command`)
    }
  }
  return findings
}

async function classifyAblationRunResult(
  summary: Record<string, unknown> | undefined,
  exitCode: number,
): Promise<{
  result_type: AblationRunRecord['result_type']
  ok: boolean
  reason: string
  pollution_findings: string[]
}> {
  if (!summary) {
    return {
      result_type: 'inconclusive',
      ok: false,
      reason: `configRunner_exit_${exitCode}`,
      pollution_findings: [],
    }
  }
  const final = (summary.final_result ?? {}) as Record<string, unknown>
  let result_type: AblationRunRecord['result_type']
  let ok: boolean
  let reason: string
  if (summary.status === 'timeout') {
    result_type = 'valid_fail'
    ok = false
    reason = 'status_timeout'
  } else if (summary.status !== 'success') {
    result_type = 'inconclusive'
    ok = false
    reason = `status_${String(summary.status)}`
  } else if (summary.reward === 1 && final.status === 'pass') {
    result_type = 'pass'
    ok = true
    reason = exitCode === 0 ? 'pass' : `pass_summary_exit_${exitCode}`
  } else if (final.status && final.status !== 'pass') {
    result_type = 'valid_fail'
    ok = false
    reason = `final_result_${String(final.status)}`
  } else if (summary.reward !== 1) {
    result_type = 'valid_fail'
    ok = false
    reason = `reward_${String(summary.reward)}`
  } else {
    result_type = 'inconclusive'
    ok = false
    reason = `final_result_${String(final.status)}`
  }

  if (result_type === 'inconclusive') {
    return { result_type, ok, reason, pollution_findings: [] }
  }
  const pollution_findings = await scanTrajectoryForNetwork(
    typeof summary.trajectory_path === 'string' ? summary.trajectory_path : undefined,
  )
  if (pollution_findings.length === 0 || (reason === 'status_timeout' && pollution_findings[0] === 'missing_trajectory_for_clean_check')) {
    return { result_type, ok, reason, pollution_findings: [] }
  }
  return {
    result_type: 'inconclusive',
    ok: false,
    reason: 'network_or_agent_pollution_check_failed',
    pollution_findings,
  }
}

async function renderAndEvaluateAblationVariant(input: {
  bundleDir: string
  outDir: string
  manifest: OracleSkillManifest
  name: string
  dropOps: string[]
  parentDropOps: string[]
  mode: AblationRunRecord['mode']
  index: number
  runOptions: AblationRunOptions
}): Promise<AblationRunRecord> {
  const variantDir = join(input.outDir, 'variants', input.name)
  const variantMetadataPath = join(input.outDir, 'metadata', 'variants', `${input.name}.json`)
  const rendered = await renderOracleSkillVariant({
    bundleDir: input.bundleDir,
    outDir: variantDir,
    dropOperationIds: input.dropOps.length > 0 ? input.dropOps : undefined,
    variantManifestPath: variantMetadataPath,
  })
  const configPath = join(input.outDir, 'configs', `${input.name}.json`)
  const runsRoot = join(input.outDir, 'eval', input.name)
  await writeJson(
    configPath,
    makeAblationEvalConfig({
      taskId: input.runOptions.taskId,
      tasksDir: input.runOptions.tasksDir,
      runsRoot: evalConfigPathValue(runsRoot),
      skillsDir: evalConfigPathValue(join(variantDir, 'skills')),
      skillName: input.manifest.skill_name,
      modelProfile: input.runOptions.modelProfile,
      modelConfigPath: input.runOptions.modelConfigPath,
      maxRounds: input.runOptions.maxRounds,
      timeoutSeconds: input.runOptions.timeoutSeconds,
    }),
  )
  const exitCode = await runEvaluationConfigRunner([
    '--config',
    configPath,
    '--condition',
    'run',
  ])
  const summaryPath = await latestRunSummaryPath(runsRoot, input.runOptions.taskId)
  const summary = await readJsonIfExists(summaryPath)
  const classified = await classifyAblationRunResult(summary, exitCode)
  const final = (summary?.final_result ?? {}) as Record<string, unknown>
  const dropOp = input.dropOps.find(op => !input.parentDropOps.includes(op))
  return {
    index: input.index,
    variant: input.name,
    mode: input.mode,
    ...(dropOp ? { drop_op: dropOp } : {}),
    drop_ops: input.dropOps,
    parent_drop_ops: input.parentDropOps,
    result_type: classified.result_type,
    ok: classified.ok,
    reason: classified.reason,
    accepted: false,
    exit_code: exitCode,
    pollution_findings: classified.pollution_findings,
    variant_dir: variantDir,
    variant_metadata_path: variantMetadataPath,
    config_path: configPath,
    ...(summaryPath ? { run_summary_path: summaryPath } : {}),
    enabled_ops: rendered.enabled_ops,
    disabled_ops: rendered.disabled_ops,
    reward: summary?.reward,
    final_status: final.status,
  }
}

function enabledAfterDropOps(manifest: OracleSkillManifest, dropOps: string[]): string[] {
  return defaultEnabledOperationIds(manifest).filter(id => !new Set(dropOps).has(id))
}

function variantNameForDropOps(manifest: OracleSkillManifest, dropOps: string[], namespace: string): string {
  return anonymizedOracleVariantName(enabledAfterDropOps(manifest, dropOps), namespace)
}

async function writeExperimentSummary(
  outDir: string,
  result: RunOracleSkillAblationExperimentResult,
  candidateOrder: OracleSkillManifest['operations'],
): Promise<void> {
  await writeJson(join(outDir, 'ablation_summary.json'), {
    bundleDir: result.bundleDir,
    outDir: result.outDir,
    status: result.status,
    mode: result.mode,
    accepted_drop_ops: result.accepted_drop_ops,
    candidate_order: candidateOrder.map(op => ({
      id: op.id,
      title: op.title,
      ablation_priority: op.ablation_priority,
    })),
    records: result.records,
  })
}

export async function runOracleSkillAblationExperiment(
  input: RunOracleSkillAblationExperimentInput,
): Promise<RunOracleSkillAblationExperimentResult> {
  const bundleDir = resolve(input.bundleDir)
  const outDir = resolve(input.outDir)
  assertSafeOutputRoot(outDir, bundleDir)
  const manifest = await assertOracleSkillBundleValid(bundleDir)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const orderedOperations = [...manifest.operations]
    .filter(op => op.enabled_by_default)
    .sort((a, b) => {
      const priority = b.ablation_priority - a.ablation_priority
      return priority !== 0 ? priority : a.id.localeCompare(b.id)
    })
  await writeJson(join(outDir, 'candidate_order.json'), {
    mode: input.dropOperationIds ? 'fixed_drop' : 'priority_greedy',
    candidates: orderedOperations.map(op => ({
      id: op.id,
      title: op.title,
      ablation_priority: op.ablation_priority,
    })),
    fixed_drop_ops: input.dropOperationIds,
  })

  const records: AblationRunRecord[] = []
  const resultsPath = join(outDir, 'ablation_results.jsonl')
  const runOptions: AblationRunOptions = {
    taskId: input.taskId,
    tasksDir: input.tasksDir,
    modelProfile: input.modelProfile,
    modelConfigPath: input.modelConfigPath,
    maxRounds: input.maxRounds,
    timeoutSeconds: input.timeoutSeconds,
  }
  const baseline = await renderAndEvaluateAblationVariant({
    bundleDir,
    outDir,
    manifest,
    name: variantNameForDropOps(manifest, [], 'baseline_full'),
    dropOps: [],
    parentDropOps: [],
    mode: 'baseline',
    index: 0,
    runOptions,
  })
  baseline.accepted = baseline.result_type === 'pass'
  records.push(baseline)
  await appendJsonl(resultsPath, baseline)
  if (baseline.result_type !== 'pass') {
    const result: RunOracleSkillAblationExperimentResult = {
      bundleDir,
      outDir,
      status: 'baseline_failed',
      mode: input.dropOperationIds ? 'fixed_drop' : 'priority_greedy',
      accepted_drop_ops: [],
      records,
    }
    await writeExperimentSummary(outDir, result, orderedOperations)
    return result
  }

  if (input.dropOperationIds) {
    const fixedDropOps = uniquePreservingOrder(input.dropOperationIds)
    resolveEnabledOperationIdsFromDropOps(manifest, fixedDropOps)
    const fixed = await renderAndEvaluateAblationVariant({
      bundleDir,
      outDir,
      manifest,
      name: variantNameForDropOps(manifest, fixedDropOps, `fixed_drop:${fixedDropOps.join('|')}`),
      dropOps: fixedDropOps,
      parentDropOps: [],
      mode: 'fixed_drop',
      index: 1,
      runOptions,
    })
    fixed.accepted = fixed.result_type === 'pass'
    records.push(fixed)
    await appendJsonl(resultsPath, fixed)
    const result: RunOracleSkillAblationExperimentResult = {
      bundleDir,
      outDir,
      status: 'completed_fixed_drop',
      mode: 'fixed_drop',
      accepted_drop_ops: fixed.accepted ? fixedDropOps : [],
      records,
    }
    await writeExperimentSummary(outDir, result, orderedOperations)
    return result
  }

  let acceptedDropOps: string[] = []
  for (const [index, op] of orderedOperations.entries()) {
    const parentDropOps = [...acceptedDropOps]
    const candidateDropOps = [...acceptedDropOps, op.id]
    const record = await renderAndEvaluateAblationVariant({
      bundleDir,
      outDir,
      manifest,
      name: variantNameForDropOps(manifest, candidateDropOps, `priority_greedy:${index + 1}`),
      dropOps: candidateDropOps,
      parentDropOps,
      mode: 'priority_greedy',
      index: index + 1,
      runOptions,
    })
    const decision = applyPriorityGreedyAblationRecord(acceptedDropOps, record)
    acceptedDropOps = decision.acceptedDropOps
    record.accepted = decision.accepted
    records.push(record)
    await appendJsonl(resultsPath, record)
    await writeExperimentSummary(
      outDir,
      {
        bundleDir,
        outDir,
        status: 'running',
        mode: 'priority_greedy',
        accepted_drop_ops: acceptedDropOps,
        records,
      },
      orderedOperations,
    )
  }

  const result: RunOracleSkillAblationExperimentResult = {
    bundleDir,
    outDir,
    status: 'completed_all_candidates',
    mode: 'priority_greedy',
    accepted_drop_ops: acceptedDropOps,
    records,
  }
  await writeExperimentSummary(outDir, result, orderedOperations)
  return result
}

export async function planOracleSkillAblations(input: {
  bundleDir: string
  dropOperationIds?: string[]
}): Promise<OracleSkillAblationPlanVariant[]> {
  const manifest = await assertOracleSkillBundleValid(input.bundleDir)
  const allEnabled = defaultEnabledOperationIds(manifest)
  if (input.dropOperationIds) {
    const dropOperationIds = uniquePreservingOrder(input.dropOperationIds)
    const enabledOperationIds = resolveEnabledOperationIdsFromDropOps(manifest, dropOperationIds)
    return [
      ablationVariant({
        semanticName: 'fixed_drop_set',
        kind: 'fixed_drop',
        namespace: `fixed_drop:${dropOperationIds.join('|')}`,
        drop_ops: dropOperationIds,
        enabledOperationIds,
      }),
    ]
  }
  const order = operationDeletionOrder(manifest)
  const variants: OracleSkillAblationPlanVariant[] = [
    ablationVariant({
      semanticName: 'full',
      kind: 'full',
      namespace: 'full',
      enabledOperationIds: allEnabled,
    }),
  ]
  for (const [index, opId] of order.entries()) {
    variants.push(ablationVariant({
      semanticName: `drop_${opId}`,
      kind: 'single_drop',
      namespace: `single_drop:${index + 1}`,
      drop_op: opId,
      enabledOperationIds: allEnabled.filter(id => id !== opId),
    }))
  }
  let greedyEnabled = [...allEnabled]
  order.forEach((opId, index) => {
    greedyEnabled = greedyEnabled.filter(id => id !== opId)
    variants.push(ablationVariant({
      semanticName: `greedy_step_${String(index + 1).padStart(2, '0')}_drop_${opId}`,
      kind: 'greedy_step',
      namespace: `greedy_step:${index + 1}`,
      drop_op: opId,
      step: index + 1,
      enabledOperationIds: [...greedyEnabled],
    }))
  })
  return variants
}

export async function ablateOracleSkillBundle(
  input: AblateOracleSkillBundleInput,
): Promise<AblateOracleSkillBundleResult> {
  const bundleDir = resolve(input.bundleDir)
  const outDir = resolve(input.outDir)
  assertSafeOutputRoot(outDir, bundleDir)
  const planned = await planOracleSkillAblations({
    bundleDir,
    dropOperationIds: input.dropOperationIds,
  })
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const variants: AblationVariant[] = []
  for (const item of planned) {
    const variantOutDir = join(outDir, item.name)
    const rendered = await renderOracleSkillVariant({
      bundleDir,
      outDir: variantOutDir,
      enabledOperationIds: item.enabledOperationIds,
    })
    variants.push({
      name: item.name,
      semantic_name: item.semanticName,
      kind: item.kind,
      drop_op: item.drop_op,
      drop_ops: item.drop_ops,
      step: item.step,
      outDir: variantOutDir,
      enabled_ops: rendered.enabled_ops,
      disabled_ops: rendered.disabled_ops,
    })
  }

  const result: AblateOracleSkillBundleResult = {
    bundleDir,
    outDir,
    variants,
  }
  await writeFile(
    join(outDir, 'ablation_manifest.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )
  return result
}
