import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  assertNoForbiddenVariantText,
  assertSafeRelativeAssetPath,
  validateOracleSkillBundle,
} from './manifest.js'
import { DEFAULT_MAX_ORACLE_OPERATIONS } from './limits.js'
import type {
  OracleOperation,
  OracleSkillDraft,
  OracleSkillDraftAsset,
  OracleSkillManifest,
  ValidationIssue,
} from './types.js'

const OP_ID_PATTERN = /^op_[0-9]{3}_[a-z0-9_]+$/
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type OracleSkillSourceIndex = {
  schema_version: 1
  task_id: string
  source_root: string
  files: Array<{
    path: string
    bytes: number
    sha256: string
  }>
}

export type MaterializeOracleSkillDraftInput = {
  draft: OracleSkillDraft
  outDir: string
  sourceIndex?: OracleSkillSourceIndex
  maxOperations?: number
}

export type MaterializeOracleSkillDraftResult = {
  manifest: OracleSkillManifest
  issues: ValidationIssue[]
}

function anchorStart(id: string): string {
  return `<!-- ORACLE_OP_START ${id} -->`
}

function anchorEnd(id: string): string {
  return `<!-- ORACLE_OP_END ${id} -->`
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim())
}

function collectKnownOperationReferences(content: string, knownIds: Set<string>): string[] {
  const matches = content.match(/\bop_[0-9]{3}_[a-z0-9_]+\b/g) ?? []
  return [...new Set(matches)].filter(id => knownIds.has(id))
}

function validateDraftShape(
  draft: OracleSkillDraft,
  options: { maxOperations?: number } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (draft.schema_version !== 1) {
    issues.push({
      code: 'draft_schema_version',
      message: 'Oracle skill draft schema_version must be 1',
    })
  }
  if (!SKILL_NAME_PATTERN.test(draft.skill_name)) {
    issues.push({
      code: 'draft_skill_name',
      message: `Skill name must match ${SKILL_NAME_PATTERN.source}`,
    })
  }
  if (!Array.isArray(draft.operations) || draft.operations.length === 0) {
    issues.push({
      code: 'draft_operations_empty',
      message: 'Oracle skill draft must contain at least one operation',
    })
    return issues
  }
  const maxOperations = options.maxOperations ?? DEFAULT_MAX_ORACLE_OPERATIONS
  if (draft.operations.length > maxOperations) {
    issues.push({
      code: 'draft_too_many_operations',
      message: `Oracle skill draft must contain at most ${maxOperations} operations`,
    })
  }

  const ids = new Set<string>()
  const indexById = new Map<string, number>()
  draft.operations.forEach((op, index) => {
    indexById.set(op.id, index)
  })
  for (const op of draft.operations) {
    if (!OP_ID_PATTERN.test(op.id)) {
      issues.push({
        code: 'draft_operation_id',
        message: `Operation id must match ${OP_ID_PATTERN.source}`,
        operationId: op.id,
      })
    }
    if (ids.has(op.id)) {
      issues.push({
        code: 'draft_duplicate_operation_id',
        message: `Duplicate operation id: ${op.id}`,
        operationId: op.id,
      })
    }
    ids.add(op.id)
    if (!op.skill_md?.trim()) {
      issues.push({
        code: 'draft_operation_skill_md',
        message: `Operation ${op.id} must include skill_md`,
        operationId: op.id,
      })
    }
    for (const dep of op.depends_on) {
      if (!ids.has(dep) && !draft.operations.some(item => item.id === dep)) {
        issues.push({
          code: 'draft_missing_dependency',
          message: `Operation ${op.id} depends on unknown operation ${dep}`,
          operationId: op.id,
        })
        continue
      }
      const dependencyIndex = indexById.get(dep)
      const opIndex = indexById.get(op.id)
      if (
        dependencyIndex !== undefined &&
        opIndex !== undefined &&
        dependencyIndex >= opIndex
      ) {
        issues.push({
          code: 'draft_dependency_order',
          message: `Operation ${op.id} must depend only on earlier operations; ${dep} appears later`,
          operationId: op.id,
        })
      }
    }
    validateAssets(op.id, op.resources, 'resources', issues)
    validateAssets(op.id, op.scripts, 'scripts', issues)
  }
  validateCrossOperationReferences(draft, ids, issues)
  return issues
}

function validateCrossOperationReferences(
  draft: OracleSkillDraft,
  ids: Set<string>,
  issues: ValidationIssue[],
): void {
  for (const op of draft.operations) {
    const allowed = new Set([op.id, ...op.depends_on])
    const sections = [
      { path: `skills/<skill>/SKILL.md#${op.id}`, content: op.skill_md },
      ...op.resources.map(asset => ({ path: asset.path, content: asset.content })),
      ...op.scripts.map(asset => ({ path: asset.path, content: asset.content })),
    ]
    for (const section of sections) {
      for (const referencedId of collectKnownOperationReferences(section.content, ids)) {
        if (allowed.has(referencedId)) continue
        issues.push({
          code: 'draft_cross_operation_reference',
          message: `Operation ${op.id} references ${referencedId} without declaring it as a dependency`,
          operationId: op.id,
          path: section.path,
        })
      }
    }
  }
}

function validateAssets(
  operationId: string,
  assets: OracleSkillDraftAsset[],
  kind: 'resources' | 'scripts',
  issues: ValidationIssue[],
): void {
  for (const asset of assets) {
    try {
      assertSafeRelativeAssetPath(asset.path)
    } catch (error) {
      issues.push({
        code: 'draft_unsafe_asset_path',
        message: error instanceof Error ? error.message : String(error),
        operationId,
        path: asset.path,
      })
      continue
    }
    if (!asset.path.startsWith(`${kind}/`)) {
      issues.push({
        code: 'draft_asset_wrong_root',
        message: `${kind} asset must be under ${kind}/: ${asset.path}`,
        operationId,
        path: asset.path,
      })
    }
    const baseName = asset.path.replace(/\\/g, '/').split('/').at(-1) ?? ''
    const operationPrefix = operationId.match(/^op_[0-9]{3}/)?.[0] ?? operationId
    if (!baseName.startsWith(operationId) && !baseName.startsWith(`${operationPrefix}_`)) {
      issues.push({
        code: 'draft_asset_not_owned',
        message: `${kind} asset file name must start with owning operation id or prefix ${operationPrefix}: ${asset.path}`,
        operationId,
        path: asset.path,
      })
    }
    if (kind === 'resources' && !asset.path.endsWith('.md')) {
      issues.push({
        code: 'draft_resource_extension',
        message: `Resource asset must be Markdown: ${asset.path}`,
        operationId,
        path: asset.path,
      })
    }
  }
}

function assertNoSolverFacingLeaks(draft: OracleSkillDraft): void {
  assertNoForbiddenVariantText({
    path: 'skills/<skill>/SKILL.md frontmatter',
    content: `${draft.skill_description}\n${draft.skill_overview}`,
  })
  assertNoGlobalOperationSummary(draft)
  for (const op of draft.operations) {
    assertNoForbiddenVariantText({
      path: `skills/<skill>/SKILL.md#${op.id}`,
      content: op.skill_md,
    })
    for (const asset of [...op.resources, ...op.scripts]) {
      assertNoForbiddenVariantText({ path: asset.path, content: asset.content })
    }
  }
}

function assertNoGlobalOperationSummary(draft: OracleSkillDraft): void {
  const globalSections = [
    { path: 'skill_description', content: draft.skill_description },
    { path: 'skill_overview', content: draft.skill_overview },
  ]
  const leaks = [
    { token: 'pipeline summary', pattern: /^\s*(?:data flow|pipeline)\s*:/im },
    { token: 'operation id', pattern: /\bop_[0-9]{3}[A-Za-z0-9_-]*\b/i },
    { token: 'ablatable', pattern: /\bablatable\b/i },
  ]
  for (const section of globalSections) {
    const leak = leaks.find(item => item.pattern.test(section.content))
    if (leak) {
      throw new Error(`Oracle skill global ${section.path} contains solver-facing ${leak.token}`)
    }
  }
}

function renderSkillMarkdown(draft: OracleSkillDraft): string {
  return [
    '---',
    `name: ${draft.skill_name}`,
    `description: ${yamlString(draft.skill_description)}`,
    '---',
    '',
    `# ${draft.skill_name} Oracle Skill`,
    '',
    draft.skill_overview.trim(),
    '',
    ...draft.operations.flatMap(op => [
      anchorStart(op.id),
      `## ${op.title}`,
      '',
      op.skill_md.trim(),
      anchorEnd(op.id),
      '',
    ]),
  ].join('\n')
}

function manifestFromDraft(draft: OracleSkillDraft): OracleSkillManifest {
  const operations: OracleOperation[] = draft.operations.map(op => ({
    id: op.id,
    kind: op.kind,
    title: op.title,
    skill_md_anchor: op.id,
    resources: op.resources.map(asset => asset.path),
    scripts: op.scripts.map(asset => asset.path),
    depends_on: op.depends_on,
    ablation_priority: op.ablation_priority,
    enabled_by_default: op.enabled_by_default,
    source_refs: op.source_refs,
  }))
  return {
    schema_version: 1,
    task_id: draft.task_id,
    skill_name: draft.skill_name,
    generated_at: new Date().toISOString(),
    operations,
    source_index_path: 'source_index.json',
  }
}

export async function materializeOracleSkillDraft(
  input: MaterializeOracleSkillDraftInput,
): Promise<MaterializeOracleSkillDraftResult> {
  const draftIssues = validateDraftShape(input.draft, { maxOperations: input.maxOperations })
  if (draftIssues.length > 0) {
    throw new Error(draftIssues.map(issue => `${issue.code}: ${issue.message}`).join('\n'))
  }
  assertNoSolverFacingLeaks(input.draft)

  const manifest = manifestFromDraft(input.draft)
  const skillRoot = join(input.outDir, 'skills', manifest.skill_name)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), renderSkillMarkdown(input.draft), 'utf8')

  for (const op of input.draft.operations) {
    for (const asset of [...op.resources, ...op.scripts]) {
      const destination = join(skillRoot, asset.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, asset.content, 'utf8')
    }
  }

  await writeFile(
    join(input.outDir, 'oracle_skill_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(input.outDir, 'source_index.json'),
    `${JSON.stringify(
      input.sourceIndex ?? {
        schema_version: 1,
        task_id: input.draft.task_id,
        source_root: 'std_code',
        files: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    join(input.outDir, 'author_draft.json'),
    `${JSON.stringify(input.draft, null, 2)}\n`,
    'utf8',
  )

  const validation = await validateOracleSkillBundle(input.outDir)
  if (!validation.ok) {
    throw new Error(validation.issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'))
  }
  return {
    manifest,
    issues: [],
  }
}
