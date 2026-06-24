import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import {
  ORACLE_OPERATION_KINDS,
  type DisabledOperation,
  type OracleOperation,
  type OracleSkillManifest,
  type ResolvedOperations,
  type ValidationIssue,
  type ValidationResult,
} from './types.js'
import { DEFAULT_MAX_ORACLE_OPERATIONS } from './limits.js'

export const ORACLE_SKILL_MANIFEST_FILE = 'oracle_skill_manifest.json'

const OP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const FORBIDDEN_VARIANT_TOKENS = [
  'std_code',
  '.judge_private',
  'ground_truth',
  'reference_outputs',
  'private_judge',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? [...value]
    : undefined
}

function isInside(path: string, parent: string): boolean {
  const child = resolve(path)
  const base = resolve(parent)
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base
  return normalizedChild === normalizedBase || normalizedChild.startsWith(`${normalizedBase}${process.platform === 'win32' ? '\\' : '/'}`)
}

export function assertSafeRelativeAssetPath(path: string): void {
  const normalized = path.replace(/\\/g, '/')
  if (
    !normalized ||
    isAbsolute(path) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('./')
  ) {
    throw new Error(`Unsafe oracle skill asset path: ${path}`)
  }
}

function parseOperation(value: unknown, index: number): OracleOperation {
  if (!isRecord(value)) throw new Error(`operations[${index}] must be an object`)
  const kind = value.kind
  if (!ORACLE_OPERATION_KINDS.includes(kind as never)) {
    throw new Error(`operations[${index}].kind is invalid`)
  }
  const op: OracleOperation = {
    id: expectString(value.id, `operations[${index}].id`),
    kind: kind as OracleOperation['kind'],
    title: expectString(value.title, `operations[${index}].title`),
    skill_md_anchor: expectString(value.skill_md_anchor, `operations[${index}].skill_md_anchor`),
    resources: expectStringArray(value.resources, `operations[${index}].resources`),
    scripts: expectStringArray(value.scripts, `operations[${index}].scripts`),
    depends_on: expectStringArray(value.depends_on, `operations[${index}].depends_on`),
    ablation_priority: expectFiniteNumber(value.ablation_priority, `operations[${index}].ablation_priority`),
    enabled_by_default: expectBoolean(value.enabled_by_default, `operations[${index}].enabled_by_default`),
  }
  const sourceRefs = stringArray(value.source_refs)
  if (sourceRefs) op.source_refs = sourceRefs
  return op
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  const parsed = stringArray(value)
  if (!parsed) throw new Error(`${path} must be an array of strings`)
  return parsed
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

export function parseOracleSkillManifest(value: unknown): OracleSkillManifest {
  if (!isRecord(value)) throw new Error('oracle skill manifest must be an object')
  const schemaVersion = value.schema_version
  if (schemaVersion !== 1) throw new Error('oracle skill manifest schema_version must be 1')
  const operationsRaw = value.operations
  if (!Array.isArray(operationsRaw) || operationsRaw.length === 0) {
    throw new Error('oracle skill manifest operations must be a non-empty array')
  }
  const manifest: OracleSkillManifest = {
    schema_version: 1,
    task_id: expectString(value.task_id, 'task_id'),
    skill_name: expectString(value.skill_name, 'skill_name'),
    operations: operationsRaw.map(parseOperation),
  }
  if (typeof value.generated_at === 'string') manifest.generated_at = value.generated_at
  if (typeof value.source_index_path === 'string') manifest.source_index_path = value.source_index_path
  return manifest
}

export async function loadOracleSkillManifest(bundleDir: string): Promise<OracleSkillManifest> {
  const raw = await readFile(join(bundleDir, ORACLE_SKILL_MANIFEST_FILE), 'utf8')
  return parseOracleSkillManifest(JSON.parse(raw))
}

function pushIssue(issues: ValidationIssue[], issue: ValidationIssue): void {
  issues.push(issue)
}

function anchorStart(anchor: string): string {
  return `<!-- ORACLE_OP_START ${anchor} -->`
}

function anchorEnd(anchor: string): string {
  return `<!-- ORACLE_OP_END ${anchor} -->`
}

function validateDependencyGraph(manifest: OracleSkillManifest, issues: ValidationIssue[]): void {
  const knownIds = new Set(manifest.operations.map(op => op.id))
  const indexById = new Map(manifest.operations.map((op, index) => [op.id, index]))
  for (const op of manifest.operations) {
    const opIndex = indexById.get(op.id) ?? -1
    for (const dependency of op.depends_on) {
      if (!knownIds.has(dependency)) {
        pushIssue(issues, {
          code: 'missing_dependency',
          message: `Operation ${op.id} depends on unknown operation ${dependency}`,
          operationId: op.id,
        })
        continue
      }
      const dependencyIndex = indexById.get(dependency) ?? -1
      if (dependencyIndex >= opIndex) {
        pushIssue(issues, {
          code: 'dependency_order',
          message: `Operation ${op.id} must depend only on earlier operations; ${dependency} appears later`,
          operationId: op.id,
        })
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(manifest.operations.map(op => [op.id, op]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const op = byId.get(id)
    for (const dependency of op?.depends_on ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const op of manifest.operations) {
    if (visit(op.id)) {
      pushIssue(issues, {
        code: 'dependency_cycle',
        message: `Operation dependency graph contains a cycle involving ${op.id}`,
        operationId: op.id,
      })
      return
    }
  }
}

export async function validateOracleSkillBundle(bundleDir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = []
  let manifest: OracleSkillManifest
  try {
    manifest = await loadOracleSkillManifest(bundleDir)
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: 'manifest_invalid',
          message: error instanceof Error ? error.message : String(error),
          path: ORACLE_SKILL_MANIFEST_FILE,
        },
      ],
    }
  }

  if (!SKILL_NAME_PATTERN.test(manifest.skill_name)) {
    pushIssue(issues, {
      code: 'invalid_skill_name',
      message: `Skill name must match ${SKILL_NAME_PATTERN.source}`,
      path: ORACLE_SKILL_MANIFEST_FILE,
    })
  }
  if (manifest.source_index_path) {
    try {
      assertSafeRelativeAssetPath(manifest.source_index_path)
      const sourceIndexPath = join(bundleDir, manifest.source_index_path)
      if (!isInside(sourceIndexPath, bundleDir)) {
        pushIssue(issues, {
          code: 'unsafe_source_index_path',
          message: `Source index path escapes bundle root: ${manifest.source_index_path}`,
          path: manifest.source_index_path,
        })
      } else if (!existsSync(sourceIndexPath)) {
        pushIssue(issues, {
          code: 'missing_source_index',
          message: `Source index does not exist: ${manifest.source_index_path}`,
          path: manifest.source_index_path,
        })
      }
    } catch (error) {
      pushIssue(issues, {
        code: 'unsafe_source_index_path',
        message: error instanceof Error ? error.message : String(error),
        path: manifest.source_index_path,
      })
    }
  }
  const seenIds = new Set<string>()
  if (manifest.operations.length > DEFAULT_MAX_ORACLE_OPERATIONS) {
    pushIssue(issues, {
      code: 'too_many_operations',
      message: `Oracle skill manifests may contain at most ${DEFAULT_MAX_ORACLE_OPERATIONS} operations`,
      path: ORACLE_SKILL_MANIFEST_FILE,
    })
  }
  for (const op of manifest.operations) {
    if (!OP_ID_PATTERN.test(op.id)) {
      pushIssue(issues, {
        code: 'invalid_operation_id',
        message: `Operation id must match ${OP_ID_PATTERN.source}`,
        operationId: op.id,
      })
    }
    if (seenIds.has(op.id)) {
      pushIssue(issues, {
        code: 'duplicate_operation_id',
        message: `Duplicate operation id: ${op.id}`,
        operationId: op.id,
      })
    }
    seenIds.add(op.id)
  }
  validateDependencyGraph(manifest, issues)

  const skillRoot = join(bundleDir, 'skills', manifest.skill_name)
  const skillMdPath = join(skillRoot, 'SKILL.md')
  let skillMarkdown = ''
  try {
    skillMarkdown = await readFile(skillMdPath, 'utf8')
  } catch {
    pushIssue(issues, {
      code: 'missing_skill_markdown',
      message: 'Skill bundle must contain skills/<skill_name>/SKILL.md',
      path: relative(bundleDir, skillMdPath).replace(/\\/g, '/'),
    })
  }

  for (const op of manifest.operations) {
    if (skillMarkdown) {
      if (!skillMarkdown.includes(anchorStart(op.skill_md_anchor))) {
        pushIssue(issues, {
          code: 'missing_anchor_start',
          message: `Missing start anchor for ${op.id}`,
          operationId: op.id,
          path: relative(bundleDir, skillMdPath).replace(/\\/g, '/'),
        })
      }
      if (!skillMarkdown.includes(anchorEnd(op.skill_md_anchor))) {
        pushIssue(issues, {
          code: 'missing_anchor_end',
          message: `Missing end anchor for ${op.id}`,
          operationId: op.id,
          path: relative(bundleDir, skillMdPath).replace(/\\/g, '/'),
        })
      }
    }

    for (const asset of [...op.resources, ...op.scripts]) {
      try {
        assertSafeRelativeAssetPath(asset)
      } catch (error) {
        pushIssue(issues, {
          code: 'unsafe_asset_path',
          message: error instanceof Error ? error.message : String(error),
          path: asset,
          operationId: op.id,
        })
        continue
      }
      const absolute = join(skillRoot, asset)
      if (!isInside(absolute, skillRoot)) {
        pushIssue(issues, {
          code: 'unsafe_asset_path',
          message: `Asset path escapes skill root: ${asset}`,
          path: asset,
          operationId: op.id,
        })
        continue
      }
      if (!existsSync(absolute)) {
        pushIssue(issues, {
          code: 'missing_asset',
          message: `Operation asset does not exist: ${asset}`,
          path: asset,
          operationId: op.id,
        })
      }
    }
  }

  return { ok: issues.length === 0, issues }
}

export async function assertOracleSkillBundleValid(bundleDir: string): Promise<OracleSkillManifest> {
  const result = await validateOracleSkillBundle(bundleDir)
  if (!result.ok) {
    throw new Error(result.issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'))
  }
  return loadOracleSkillManifest(bundleDir)
}

export function defaultEnabledOperationIds(manifest: OracleSkillManifest): string[] {
  return manifest.operations
    .filter(op => op.enabled_by_default)
    .map(op => op.id)
}

export function resolveEnabledOperationIdsFromDropOps(
  manifest: OracleSkillManifest,
  dropOperationIds: string[],
): string[] {
  if (dropOperationIds.length === 0) {
    throw new Error('drop operation ids must be non-empty')
  }
  const knownIds = new Set(manifest.operations.map(op => op.id))
  const defaultEnabled = defaultEnabledOperationIds(manifest)
  const defaultEnabledSet = new Set(defaultEnabled)
  const dropSet = new Set(dropOperationIds)

  for (const id of dropSet) {
    if (!knownIds.has(id)) throw new Error(`Unknown oracle operation id: ${id}`)
    if (!defaultEnabledSet.has(id)) {
      throw new Error(`Oracle operation is not enabled by default and cannot be dropped: ${id}`)
    }
  }

  const enabledOperationIds = defaultEnabled.filter(id => !dropSet.has(id))
  return enabledOperationIds
}

export function resolveEnabledOperations(
  manifest: OracleSkillManifest,
  requestedOperationIds?: string[],
): ResolvedOperations {
  const knownIds = new Set(manifest.operations.map(op => op.id))
  for (const id of requestedOperationIds ?? []) {
    if (!knownIds.has(id)) throw new Error(`Unknown oracle operation id: ${id}`)
  }

  const requested = new Set(requestedOperationIds ?? defaultEnabledOperationIds(manifest))
  const enabled = new Set(requested)
  const disabledReasons = new Map<string, string>()
  for (const op of manifest.operations) {
    if (!enabled.has(op.id)) {
      disabledReasons.set(op.id, requestedOperationIds ? 'disabled_by_request' : 'disabled_by_default')
    }
  }

  const disabledOps: DisabledOperation[] = manifest.operations
    .filter(op => !enabled.has(op.id))
    .map(op => ({
      id: op.id,
      reason: disabledReasons.get(op.id) ?? 'disabled',
    }))

  return {
    enabledOps: manifest.operations.filter(op => enabled.has(op.id)),
    disabledOps,
  }
}

export function assertNoForbiddenVariantText(input: {
  path: string
  content: string
}): void {
  const lower = input.content.toLowerCase()
  const token = FORBIDDEN_VARIANT_TOKENS.find(item => lower.includes(item))
  if (token) {
    throw new Error(`Rendered oracle skill contains forbidden token "${token}" in ${input.path}`)
  }
}
