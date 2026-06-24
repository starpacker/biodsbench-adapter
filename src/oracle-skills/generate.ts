import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { join, relative, resolve } from 'path'
import type {
  GenerateOracleSkillBundleInput,
  GenerateOracleSkillBundleResult,
  OracleOperation,
  OracleSkillManifest,
} from './types.js'
import { materializeOracleSkillDraft, type OracleSkillSourceIndex } from './materialize.js'
import {
  ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT,
  buildOracleSkillAuthorUserPrompt,
  buildOracleSkillRepairPrompt,
} from './prompts.js'
import { ORACLE_SKILL_DRAFT_JSON_SCHEMA } from './schema.js'
import { DEFAULT_MAX_ORACLE_OPERATIONS, HARD_MAX_ORACLE_OPERATIONS } from './limits.js'
// NOTE: `queryEngineAuthor.ts` transitively pulls in the entire Claude Code
// QueryEngine (React UI components included). Importing it eagerly forces all
// downstream consumers — including the lightweight `template` generation mode —
// to ship the React runtime. We therefore load it lazily on first use below.
import {
  RunEventLogger,
  summarizeAgentEvent,
} from '../harness/evaluation/runEventLogger.js'
import { SourceTrajectoryWriter } from '../harness/evaluation/sourceTrajectoryWriter.js'
import type { SourceAgentEvent, TaskRun } from '../harness/evaluation/types.js'

const MAX_FILE_CHARS = 12_000
const MAX_REFERENCE_FILES = 40
const MAX_PROMPT_EXCERPT_CHARS = 24_000

type SourceIndexEntry = {
  path: string
  bytes: number
  sha256: string
}

function safeSkillName(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return `oracle-${slug || 'task'}`
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return stripUtf8Bom(await readFile(path, 'utf8'))
  } catch {
    return ''
  }
}

function isIgnoredSourcePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  const base = parts.at(-1) ?? ''
  return (
    parts.includes('__pycache__') ||
    base.startsWith('.') ||
    base.endsWith('.pyc') ||
    base.endsWith('.pyo') ||
    base.endsWith('~') ||
    base.toLowerCase() === 'thumbs.db'
  )
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    const rel = relative(root, absolute).replace(/\\/g, '/')
    if (isIgnoredSourcePath(rel)) continue
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)))
    } else if (entry.isFile()) {
      files.push(absolute)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function sanitizeReferenceText(value: string): string {
  return value
    .replace(/std_code/gi, 'reference implementation')
    .replace(/\.judge_private/gi, 'judge-private-area')
    .replace(/private_judge/gi, 'judge area')
    .replace(/ground_truth/gi, 'target array')
    .replace(/reference_outputs/gi, 'reference outputs')
}

function clip(value: string, maxChars = MAX_FILE_CHARS): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n# [truncated after ${maxChars} chars]\n`
}

function promptExcerpt(value: string): string {
  return clip(value, MAX_PROMPT_EXCERPT_CHARS)
}

function resolveMaxOperations(value: number | undefined): number {
  const maxOperations = value ?? DEFAULT_MAX_ORACLE_OPERATIONS
  if (!Number.isInteger(maxOperations) || maxOperations <= 0) {
    throw new Error('maxOperations must be a positive integer')
  }
  if (maxOperations > HARD_MAX_ORACLE_OPERATIONS) {
    throw new Error(`maxOperations must be at most ${HARD_MAX_ORACLE_OPERATIONS}`)
  }
  return maxOperations
}

function formatSourceManifest(entries: SourceIndexEntry[]): string {
  if (entries.length === 0) return '(No standard implementation files found.)'
  return entries
    .map(entry => `- ${entry.path} bytes=${entry.bytes} sha256=${entry.sha256}`)
    .join('\n')
}

async function collectPublicMaterialFiles(taskDir: string): Promise<string[]> {
  const files: string[] = []
  for (const file of ['README.md', 'output_schema.json']) {
    if (existsSync(join(taskDir, file))) files.push(file)
  }
  const visibleDir = join(taskDir, 'visible_data')
  for (const file of await collectFiles(visibleDir)) {
    files.push(relative(taskDir, file).replace(/\\/g, '/'))
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function formatPublicManifest(files: string[]): string {
  return files.length > 0 ? files.map(file => `- ${file}`).join('\n') : '(No public materials found.)'
}

function fenced(path: string, content: string): string {
  const language = path.endsWith('.py')
    ? 'python'
    : path.endsWith('.json')
    ? 'json'
    : path.endsWith('.md')
    ? 'markdown'
    : ''
  return [`### ${path}`, '', `\`\`\`${language}`, clip(sanitizeReferenceText(content)), '```'].join('\n')
}

function renderSkillMarkdown(input: {
  taskId: string
  skillName: string
  operations: OracleOperation[]
}): string {
  return [
    '---',
    `name: ${input.skillName}`,
    `description: Oracle skill distilled from the ${input.taskId} reference implementation`,
    '---',
    '',
    `# ${input.taskId} Oracle Skill`,
    '',
    'Use this skill as a task-specific oracle knowledge bundle. Apply the enabled operation sections in order, and prefer the current public task files when they conflict with these notes.',
    '',
    '<!-- ORACLE_OP_START op_010_current_contract -->',
    '## 1. Current Task Contract',
    '',
    '- Read `resources/op_010_current_contract.md` before writing solver code.',
    '- Extract input keys, shapes, dtypes, units, output arrays, and visible case IDs into `workspace/current_task_contract.md`.',
    '- Do not start a long run until the public contract and output schema are written down.',
    '<!-- ORACLE_OP_END op_010_current_contract -->',
    '',
    '<!-- ORACLE_OP_START op_020_io_and_data -->',
    '## 2. Data Loading And I/O',
    '',
    '- Read `resources/op_020_io_and_data.md` and inspect the visible files under `public/`.',
    '- Write a small data probe under `workspace/` that prints available keys, shapes, ranges, finite status, and case-specific metadata.',
    '- Keep all generated outputs under `outputs/` and all scratch work under `workspace/`.',
    '<!-- ORACLE_OP_END op_020_io_and_data -->',
    '',
    '<!-- ORACLE_OP_START op_030_reference_knowledge -->',
    '## 3. Reference Implementation Knowledge',
    '',
    '- Read `resources/op_030_reference_notes.md` for the standard algorithm flow, formulas, and implementation conventions.',
    '- Recreate the relevant logic in run-local code; do not import or reference external task directories.',
    '- If the notes include code excerpts, adapt them to current `public/` paths and the public output contract.',
    '<!-- ORACLE_OP_END op_030_reference_knowledge -->',
    '',
    '<!-- ORACLE_OP_START op_040_solver_flow -->',
    '## 4. Solver Flow',
    '',
    '- Read `resources/op_040_solver_flow.md` and implement the solver stages in the listed order.',
    '- Run the cheapest possible smoke test before full optimization or simulation.',
    '- Log runtime, selected device, key loss/objective values, and output statistics.',
    '<!-- ORACLE_OP_END op_040_solver_flow -->',
    '',
    '<!-- ORACLE_OP_START op_050_output_validation -->',
    '## 5. Output Validation',
    '',
    '- Read `resources/op_050_output_validation.md` before calling `finalize_submission`.',
    '- Optionally run `python ${CLAUDE_SKILL_DIR}/scripts/op_050_validate_outputs.py` from the run root for a generic schema/finite check.',
    '- Fix output path, shape, dtype, and finite-value issues before judging quality.',
    '<!-- ORACLE_OP_END op_050_output_validation -->',
    '',
  ].join('\n')
}

function operations(): OracleOperation[] {
  return [
    {
      id: 'op_010_current_contract',
      kind: 'contract',
      title: 'Extract the current public task contract',
      skill_md_anchor: 'op_010_current_contract',
      resources: ['resources/op_010_current_contract.md'],
      scripts: [],
      depends_on: [],
      ablation_priority: 10,
      enabled_by_default: true,
    },
    {
      id: 'op_020_io_and_data',
      kind: 'data_loading',
      title: 'Inspect data loading and I/O conventions',
      skill_md_anchor: 'op_020_io_and_data',
      resources: ['resources/op_020_io_and_data.md'],
      scripts: [],
      depends_on: ['op_010_current_contract'],
      ablation_priority: 20,
      enabled_by_default: true,
    },
    {
      id: 'op_030_reference_knowledge',
      kind: 'physics_model',
      title: 'Apply standard implementation formulas and conventions',
      skill_md_anchor: 'op_030_reference_knowledge',
      resources: ['resources/op_030_reference_notes.md'],
      scripts: [],
      depends_on: ['op_010_current_contract', 'op_020_io_and_data'],
      ablation_priority: 50,
      enabled_by_default: true,
    },
    {
      id: 'op_040_solver_flow',
      kind: 'solver',
      title: 'Follow the solver flow and runtime discipline',
      skill_md_anchor: 'op_040_solver_flow',
      resources: ['resources/op_040_solver_flow.md'],
      scripts: [],
      depends_on: ['op_030_reference_knowledge'],
      ablation_priority: 40,
      enabled_by_default: true,
    },
    {
      id: 'op_050_output_validation',
      kind: 'validation',
      title: 'Validate final submission files',
      skill_md_anchor: 'op_050_output_validation',
      resources: ['resources/op_050_output_validation.md'],
      scripts: ['scripts/op_050_validate_outputs.py'],
      depends_on: ['op_010_current_contract'],
      ablation_priority: 30,
      enabled_by_default: true,
    },
  ]
}

function renderValidationScript(): string {
  return [
    'import json',
    'from pathlib import Path',
    '',
    'import numpy as np',
    '',
    'root = Path.cwd()',
    'schema_path = root / "public" / "output_schema.json"',
    'outputs = root / "outputs"',
    'schema = json.loads(schema_path.read_text(encoding="utf-8")) if schema_path.exists() else {}',
    'arrays = schema.get("arrays", [])',
    'files = sorted(outputs.glob("*.npz"))',
    'print(f"output_files={len(files)}")',
    'for file in files:',
    '    data = np.load(file)',
    '    print(f"{file.name}: keys={sorted(data.files)}")',
    '    for item in arrays:',
    '        key = item.get("key")',
    '        if key and key in data:',
    '            arr = data[key]',
    '            print(f"  {key}: shape={arr.shape} dtype={arr.dtype} finite={np.isfinite(arr).all()}")',
    '',
  ].join('\n')
}

async function buildSourceIndex(stdCodeDir: string, options?: { includeNotes?: boolean }): Promise<{
  entries: SourceIndexEntry[]
  notes: string
}> {
  const includeNotes = options?.includeNotes ?? true
  const files = (await collectFiles(stdCodeDir)).slice(0, MAX_REFERENCE_FILES)
  const entries: SourceIndexEntry[] = []
  const noteBlocks: string[] = []
  for (const file of files) {
    const content = await readFile(file)
    const rel = relative(stdCodeDir, file).replace(/\\/g, '/')
    const fileStat = await stat(file)
    entries.push({
      path: `std_code/${rel}`,
      bytes: fileStat.size,
      sha256: sha256(content),
    })
    if (includeNotes) noteBlocks.push(fenced(rel, content.toString('utf8')))
  }
  return {
    entries,
    notes: noteBlocks.length > 0
      ? noteBlocks.join('\n\n')
      : 'No standard implementation source files were found.',
  }
}

async function generateTemplateOracleSkillBundle(
  input: GenerateOracleSkillBundleInput,
): Promise<GenerateOracleSkillBundleResult> {
  const tasksDir = resolve(input.tasksDir ?? 'tasks')
  const taskDir = resolve(tasksDir, input.taskId)
  const stdCodeDir = join(taskDir, 'std_code')
  const bundleDir = resolve(input.outDir)
  const skillName = input.skillName ?? safeSkillName(input.taskId)
  const skillDir = join(bundleDir, 'skills', skillName)
  const resourcesDir = join(skillDir, 'resources')
  const scriptsDir = join(skillDir, 'scripts')
  const ops = operations()
  const maxOperations = resolveMaxOperations(input.maxOperations)
  if (ops.length > maxOperations) {
    throw new Error(`Template oracle skill has ${ops.length} operations, exceeding maxOperations=${maxOperations}`)
  }

  const [readme, outputSchema, visibleCases, sourceIndex] = await Promise.all([
    readTextIfExists(join(taskDir, 'README.md')),
    readTextIfExists(join(taskDir, 'output_schema.json')),
    readTextIfExists(join(taskDir, 'visible_data', 'cases.json')),
    buildSourceIndex(stdCodeDir),
  ])

  await rm(bundleDir, { recursive: true, force: true })
  await mkdir(resourcesDir, { recursive: true })
  await mkdir(scriptsDir, { recursive: true })

  await writeFile(join(skillDir, 'SKILL.md'), renderSkillMarkdown({
    taskId: input.taskId,
    skillName,
    operations: ops,
  }), 'utf8')
  await writeFile(
    join(resourcesDir, 'op_010_current_contract.md'),
    [
      '# Current Task Contract',
      '',
      '## README',
      '',
      readme || '(README.md was not found.)',
      '',
      '## Output Schema',
      '',
      '```json',
      outputSchema || '{}',
      '```',
      '',
      '## Visible Cases',
      '',
      '```json',
      visibleCases || '{}',
      '```',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(resourcesDir, 'op_020_io_and_data.md'),
    [
      '# Data Loading And I/O Notes',
      '',
      '- Start from the public files listed in the prompt.',
      '- Probe each visible case before choosing a solver.',
      '- Reconcile every generated file with the output schema and case IDs.',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(resourcesDir, 'op_030_reference_notes.md'),
    [
      '# Reference Implementation Notes',
      '',
      'The following excerpts are copied into this oracle bundle for analysis and adaptation. File names are relative to the reference source root.',
      '',
      sourceIndex.notes,
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(resourcesDir, 'op_040_solver_flow.md'),
    [
      '# Solver Flow',
      '',
      '1. Extract the current public contract and case metadata.',
      '2. Recreate the reference data loading flow using run-local `public/` paths.',
      '3. Implement the forward model, objective, solver loop, and post-processing from the reference notes.',
      '4. Run a cheap smoke test, then a bounded full solve.',
      '5. Write outputs in the public schema format.',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(resourcesDir, 'op_050_output_validation.md'),
    [
      '# Output Validation',
      '',
      '- Confirm required files exist under `outputs/`.',
      '- Confirm all required arrays are present, finite, and shaped according to `public/output_schema.json`.',
      '- Confirm dtype expectations before calling `finalize_submission`.',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(scriptsDir, 'op_050_validate_outputs.py'), renderValidationScript(), 'utf8')

  const manifest: OracleSkillManifest = {
    schema_version: 1,
    task_id: input.taskId,
    skill_name: skillName,
    generated_at: new Date().toISOString(),
    operations: ops,
    source_index_path: 'source_index.json',
  }
  await writeFile(
    join(bundleDir, 'oracle_skill_manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(bundleDir, 'source_index.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        task_id: input.taskId,
        source_root: 'std_code',
        files: sourceIndex.entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return {
    bundleDir,
    skillName,
    operationIds: ops.map(op => op.id),
    mode: 'template',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function clearMaterializedBundleFiles(bundleDir: string): Promise<void> {
  await Promise.all([
    rm(join(bundleDir, 'skills'), { recursive: true, force: true }),
    rm(join(bundleDir, 'oracle_skill_manifest.json'), { force: true }),
    rm(join(bundleDir, 'source_index.json'), { force: true }),
    rm(join(bundleDir, 'author_draft.json'), { force: true }),
  ])
}

async function writeAuthorPrompts(input: {
  promptDir: string
  systemPrompt: string
  userPrompt: string
}): Promise<{ system: string; user: string }> {
  await mkdir(input.promptDir, { recursive: true })
  const system = join(input.promptDir, 'author.system.md')
  const user = join(input.promptDir, 'author.user.md')
  await writeFile(system, input.systemPrompt, 'utf8')
  await writeFile(user, input.userPrompt, 'utf8')
  return { system, user }
}

export type BuildOracleSkillAuthorPromptsInput = {
  taskId: string
  tasksDir?: string
  outDir?: string
  skillName?: string
  authorWorkspaceDir?: string
  maxOperations?: number
}

export async function buildOracleSkillAuthorPromptsForTask(
  input: BuildOracleSkillAuthorPromptsInput,
): Promise<{
  taskDir: string
  bundleDir: string
  skillName: string
  authorWorkspaceDir: string
  systemPrompt: string
  userPrompt: string
  sourceIndex: OracleSkillSourceIndex
}> {
  const tasksDir = resolve(input.tasksDir ?? 'tasks')
  const taskDir = resolve(tasksDir, input.taskId)
  const stdCodeDir = join(taskDir, 'std_code')
  const bundleDir = resolve(input.outDir ?? join('output', 'oracle-skills', input.taskId))
  const skillName = input.skillName ?? safeSkillName(input.taskId)
  const maxOperations = resolveMaxOperations(input.maxOperations)
  const authorWorkspaceDir = resolve(
    input.authorWorkspaceDir ?? join(bundleDir, '.authoring', 'workspace'),
  )

  const [readme, outputSchema, visibleCases, publicFiles, sourceIndex] =
    await Promise.all([
      readTextIfExists(join(taskDir, 'README.md')),
      readTextIfExists(join(taskDir, 'output_schema.json')),
      readTextIfExists(join(taskDir, 'visible_data', 'cases.json')),
      collectPublicMaterialFiles(taskDir),
      buildSourceIndex(stdCodeDir, { includeNotes: false }),
    ])

  const sourceIndexDoc: OracleSkillSourceIndex = {
    schema_version: 1,
    task_id: input.taskId,
    source_root: 'std_code',
    files: sourceIndex.entries,
  }
  const systemPrompt = ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT
  const userPrompt = buildOracleSkillAuthorUserPrompt({
    taskId: input.taskId,
    taskDir,
    skillName,
    authorWorkspace: authorWorkspaceDir,
    readmeExcerpt: promptExcerpt(readme),
    outputSchemaExcerpt: promptExcerpt(outputSchema),
    visibleCasesExcerpt: promptExcerpt(visibleCases),
    publicFileManifest: formatPublicManifest(publicFiles),
    standardSourceManifest: formatSourceManifest(sourceIndex.entries),
    maxOperations,
  })
  return {
    taskDir,
    bundleDir,
    skillName,
    authorWorkspaceDir,
    systemPrompt,
    userPrompt,
    sourceIndex: sourceIndexDoc,
  }
}

async function generateQueryEngineOracleSkillBundle(
  input: GenerateOracleSkillBundleInput,
): Promise<GenerateOracleSkillBundleResult> {
  const promptBundle = await buildOracleSkillAuthorPromptsForTask(input)
  const maxOperations = resolveMaxOperations(input.maxOperations)
  const {
    taskDir,
    bundleDir,
    authorWorkspaceDir,
    systemPrompt,
    userPrompt,
    sourceIndex,
  } = promptBundle
  const promptDir = resolve(input.promptOutDir ?? join(bundleDir, '.authoring', 'prompts'))
  const authorLogPath = join(bundleDir, '.authoring', 'events.json')

  await rm(bundleDir, { recursive: true, force: true })
  await mkdir(authorWorkspaceDir, { recursive: true })
  await mkdir(dirnameCompat(authorLogPath), { recursive: true })
  const promptPaths = await writeAuthorPrompts({ promptDir, systemPrompt, userPrompt })
  const authorTaskRun = createAuthorTaskRun({
    taskId: input.taskId,
    taskDir,
    bundleDir,
  })
  const trajectory = new SourceTrajectoryWriter(authorTaskRun)
  const eventLogger = new RunEventLogger({
    taskRun: authorTaskRun,
    verbose: Boolean(process.env.ORACLE_SKILL_AUTHOR_VERBOSE),
  })
  const startedAt = new Date().toISOString()
  await trajectory.start({ startedAt })
  await trajectory.appendClean({
    kind: 'initial_prompt_audit',
    expected_known_task_materials_block: false,
    has_known_task_materials_block: false,
    known_task_materials_block_allowed: false,
    known_task_materials_prompt_mode: 'none',
  })
  await eventLogger.log('run_started', {
    message: 'Oracle skill authoring started',
    details: {
      bundle_dir: bundleDir,
      prompt_paths: promptPaths,
      trajectory_clean_path: trajectory.cleanPath,
      trajectory_raw_path: trajectory.rawPath,
    },
  })

  const logAuthorEvent = async (turnIndex: number, event: unknown): Promise<void> => {
    const sourceEvent = asSourceAgentEvent(event)
    await trajectory.agentEvent(turnIndex, sourceEvent)
    await eventLogger.log('agent_event', {
      agent_step: turnIndex,
      details: summarizeAgentEvent(sourceEvent),
    })
  }
  const sessionFactory =
    input.authorSessionFactory ??
    (await import('./queryEngineAuthor.js')).createQueryEngineOracleSkillAuthorSession
  const session = await sessionFactory({
    cwd: process.cwd(),
    taskDir,
    authorWorkspaceDir,
    systemPrompt,
    jsonSchema: ORACLE_SKILL_DRAFT_JSON_SCHEMA as unknown as Record<string, unknown>,
    maxTurns: input.maxTurns ?? 12,
  })

  const allEvents: unknown[] = []
  try {
    await eventLogger.log('agent_step_started', {
      agent_step: 1,
      message: 'Submitting oracle skill author prompt',
    })
    let turn = await session.submit(userPrompt, {
      onEvent: event => logAuthorEvent(1, event),
    })
    allEvents.push(...turn.events)
    await eventLogger.log('agent_step_finished', {
      agent_step: 1,
      message: 'Oracle skill author prompt completed',
    })
    try {
      await materializeOracleSkillDraft({
        draft: turn.draft,
        outDir: bundleDir,
        sourceIndex,
        maxOperations,
      })
    } catch (error) {
      await clearMaterializedBundleFiles(bundleDir)
      const repairPrompt = buildOracleSkillRepairPrompt([
        { code: 'materialize_failed', message: errorMessage(error) },
      ])
      await eventLogger.log('agent_recovery_started', {
        agent_step: 2,
        message: 'Submitting oracle skill repair prompt',
        details: { error: errorMessage(error) },
      })
      await trajectory.appendClean({
        kind: 'recovery_started',
        round: 2,
        message: errorMessage(error),
      })
      turn = await session.submit(repairPrompt, {
        onEvent: event => logAuthorEvent(2, event),
      })
      allEvents.push(...turn.events)
      await eventLogger.log('agent_recovery_finished', {
        agent_step: 2,
        message: 'Oracle skill repair prompt completed',
      })
      await trajectory.appendClean({
        kind: 'recovery_finished',
        round: 2,
        finalized: false,
        summary: 'Repaired oracle skill draft received',
      })
      await materializeOracleSkillDraft({
        draft: turn.draft,
        outDir: bundleDir,
        sourceIndex,
        maxOperations,
      })
    }
    await trajectory.appendClean({
      kind: 'run_finished',
      status: 'success',
      reward: 0,
      completed_at: new Date().toISOString(),
    })
    await eventLogger.log('run_finished', {
      message: 'Oracle skill authoring finished',
      details: {
        trajectory_path: trajectory.cleanPath,
        raw_trajectory_path: trajectory.rawPath,
      },
    })
  } finally {
    await writeFile(authorLogPath, `${JSON.stringify(allEvents, null, 2)}\n`, 'utf8')
    await session.dispose?.()
  }

  const manifest = JSON.parse(
    await readFile(join(bundleDir, 'oracle_skill_manifest.json'), 'utf8'),
  ) as OracleSkillManifest
  return {
    bundleDir,
    skillName: manifest.skill_name,
    operationIds: manifest.operations.map(op => op.id),
    mode: 'query-engine',
    draftPath: join(bundleDir, 'author_draft.json'),
    promptPaths,
    authorLogPath,
    trajectoryPaths: {
      clean: trajectory.cleanPath,
      raw: trajectory.rawPath,
      events: eventLogger.path,
    },
  }
}

function dirnameCompat(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index >= 0 ? path.slice(0, index) : '.'
}

function createAuthorTaskRun(input: {
  taskId: string
  taskDir: string
  bundleDir: string
}): TaskRun {
  const logsDir = join(input.bundleDir, '.authoring', 'logs')
  return {
    taskId: input.taskId,
    runId: 'oracle-skill-author',
    runDir: input.bundleDir,
    judgeDir: '',
    publicDir: input.taskDir,
    workspaceDir: join(input.bundleDir, '.authoring', 'workspace'),
    outputsDir: input.bundleDir,
    logsDir,
    taskDir: input.taskDir,
    manifest: {
      version: 1,
      task_id: input.taskId,
    },
  }
}

function asSourceAgentEvent(event: unknown): SourceAgentEvent {
  return event as SourceAgentEvent
}

export async function generateOracleSkillBundle(
  input: GenerateOracleSkillBundleInput,
): Promise<GenerateOracleSkillBundleResult> {
  return input.mode === 'template'
    ? generateTemplateOracleSkillBundle(input)
    : generateQueryEngineOracleSkillBundle(input)
}
