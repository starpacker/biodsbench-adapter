export const ORACLE_OPERATION_KINDS = [
  'contract',
  'data_loading',
  'physics_model',
  'solver',
  'postprocess',
  'validation',
  'runtime_probe',
] as const

export type OracleOperationKind = (typeof ORACLE_OPERATION_KINDS)[number]

export type OracleOperation = {
  id: string
  kind: OracleOperationKind
  title: string
  skill_md_anchor: string
  resources: string[]
  scripts: string[]
  depends_on: string[]
  ablation_priority: number
  enabled_by_default: boolean
  source_refs?: string[]
}

export type OracleSkillManifest = {
  schema_version: 1
  task_id: string
  skill_name: string
  generated_at?: string
  operations: OracleOperation[]
  source_index_path?: string
}

export type ValidationIssue = {
  code: string
  message: string
  path?: string
  operationId?: string
}

export type ValidationResult = {
  ok: boolean
  issues: ValidationIssue[]
}

export type DisabledOperation = {
  id: string
  reason: string
}

export type ResolvedOperations = {
  enabledOps: OracleOperation[]
  disabledOps: DisabledOperation[]
}

export type VariantManifest = {
  schema_version: 1
  source_bundle: string
  skill_name: string
  enabled_ops: string[]
  disabled_ops: DisabledOperation[]
  copied_resources: string[]
  copied_scripts: string[]
  generated_at: string
}

export type RenderOracleSkillVariantInput = {
  bundleDir: string
  outDir: string
  enabledOperationIds?: string[]
  dropOperationIds?: string[]
  variantManifestPath?: string
}

export type RenderOracleSkillVariantResult = VariantManifest

export type GenerateOracleSkillBundleInput = {
  taskId: string
  tasksDir?: string
  outDir: string
  skillName?: string
  mode?: OracleSkillGenerationMode
  promptOutDir?: string
  maxTurns?: number
  maxOperations?: number
  authorWorkspaceDir?: string
  authorSessionFactory?: OracleSkillAuthorSessionFactory
}

export type GenerateOracleSkillBundleResult = {
  bundleDir: string
  skillName: string
  operationIds: string[]
  mode: OracleSkillGenerationMode
  draftPath?: string
  promptPaths?: {
    system: string
    user: string
  }
  authorLogPath?: string
  trajectoryPaths?: {
    clean: string
    raw: string
    events: string
  }
}

export type OracleSkillGenerationMode = 'query-engine' | 'template'

export type OracleSkillDraftAsset = {
  path: string
  content: string
}

export type OracleSkillDraftOperation = {
  id: string
  kind: OracleOperationKind
  title: string
  depends_on: string[]
  ablation_priority: number
  enabled_by_default: true
  source_refs: string[]
  skill_md: string
  resources: OracleSkillDraftAsset[]
  scripts: OracleSkillDraftAsset[]
}

export type OracleSkillDraft = {
  schema_version: 1
  task_id: string
  skill_name: string
  skill_description: string
  skill_overview: string
  operations: OracleSkillDraftOperation[]
  self_check: {
    atomicity_notes: string[]
    safety_notes: string[]
    likely_critical_ops: string[]
    likely_removable_ops: string[]
  }
}

export type OracleSkillAuthorEvent = {
  type: string
  [key: string]: unknown
}

export type OracleSkillAuthorTurnResult = {
  draft: OracleSkillDraft
  events: OracleSkillAuthorEvent[]
}

export type OracleSkillAuthorSession = {
  submit(
    prompt: string,
    options?: {
      onEvent?: (event: OracleSkillAuthorEvent) => Promise<void> | void
    },
  ): Promise<OracleSkillAuthorTurnResult>
  dispose?(): Promise<void>
}

export type OracleSkillAuthorSessionStartInput = {
  cwd: string
  taskDir: string
  authorWorkspaceDir: string
  systemPrompt: string
  jsonSchema: Record<string, unknown>
  maxTurns?: number
}

export type OracleSkillAuthorSessionFactory = (
  input: OracleSkillAuthorSessionStartInput,
) => Promise<OracleSkillAuthorSession>

export type AblationVariant = {
  name: string
  semantic_name?: string
  kind?: OracleSkillAblationVariantKind
  drop_op?: string
  drop_ops?: string[]
  step?: number
  outDir: string
  enabled_ops: string[]
  disabled_ops: DisabledOperation[]
}

export type AblateOracleSkillBundleInput = {
  bundleDir: string
  outDir: string
  dropOperationIds?: string[]
}

export type OracleSkillAblationVariantKind = 'full' | 'single_drop' | 'greedy_step' | 'fixed_drop'

export type OracleSkillAblationPlanVariant = {
  name: string
  semanticName: string
  kind: OracleSkillAblationVariantKind
  drop_op?: string
  drop_ops?: string[]
  step?: number
  enabledOperationIds: string[]
}

export type AblateOracleSkillBundleResult = {
  bundleDir: string
  outDir: string
  variants: AblationVariant[]
}
