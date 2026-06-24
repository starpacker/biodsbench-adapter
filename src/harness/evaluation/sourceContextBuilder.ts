import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'
import type { ResumeRunSnapshot } from './runResume.js'
import type {
  EvaluationNetworkPolicy,
  JudgeResult,
  RuntimeInfo,
  TaskRun,
} from './types.js'

type OutputSchema = {
  submission?: {
    path_template?: string
  }
  path_template?: string
  arrays?: Array<{
    key?: string
    shape?: unknown
    dtype?: unknown
  }>
  validation?: {
    finite_only?: boolean
  }
}

type CasesConfig = {
  cases?: Array<{
    id?: string
    input_dir?: string
    params?: string
    expected_output?: string
    description?: string
  }>
}

type CompactJudgeFeedback = {
  format: string
  reasons: string[]
  failedMetrics: string[]
  passedMetrics: string[]
  message?: string
}

type SourcePromptPolicyOptions = {
  networkPolicy?: EvaluationNetworkPolicy
  agentToolAvailable?: boolean
}

export const KNOWN_TASK_MATERIALS_PROMPT_BLOCK = [
  '<known_task_materials>',
  'Additional readable materials are available under public/known_tasks/.',
  '</known_task_materials>',
].join('\n')

export const KNOWN_TASK_MATERIALS_DEEP_READ_PROMPT_BLOCK = [
  '<known_task_materials>',
  'Additional readable materials are available under public/known_tasks/.',
  'Before implementation or long experiments, inspect every known task\'s README.md and its std_code entry points, including main.py and src modules for data loading, physics/forward models, solvers, preprocessing, and output writing.',
  'When more than one known task is exposed, do not assume any single one matches the current task end to end. Decompose the current task into dimensions such as data and hardware geometry, forward physics, inversion algorithm, regularization, and output construction. For each dimension, decide whether a known material is directly reusable, needs adaptation (different time or frequency representation, different solver family, different boundary handling, different units or scaling), or has no reusable counterpart and must be designed from public/ alone.',
  'Call out paradigm mismatches between the known materials and the current task and sketch a concrete adaptation before writing solver code.',
  'Write concise per-dimension notes to workspace/known_task_materials_notes.md.',
  'At the top of workspace/plans/round_NN.md, include a "Known-task synthesis" section that records the per-dimension reuse/adapt/novel decisions, the adaptations required, and the parts that must be designed from public/ alone.',
  'Decide yourself whether any material is relevant; do not blindly copy constants, file paths, fixed iteration counts, or task-specific recipes from known std_code.',
  '</known_task_materials>',
].join('\n')

export function knownTaskMaterialsPromptBlock(
  deepRead = false,
  _options?: SourcePromptPolicyOptions,
): string {
  return deepRead
    ? KNOWN_TASK_MATERIALS_DEEP_READ_PROMPT_BLOCK
    : KNOWN_TASK_MATERIALS_PROMPT_BLOCK
}

export function activeSkillsPromptBlock(skillNames: string[] = []): string {
  const visibleNames = [...new Set(skillNames.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
  return [
    '<active_skills>',
    'The native Skill tool is enabled for this run.',
    'At the start of each judge round, before writing the round plan or solver code, call the Skill tool to inspect relevant active skills and incorporate any applicable reusable guidance.',
    'Use retrieved skill guidance as abstract process advice only; do not infer or request hidden task materials from it.',
    'In the round plan, include a section named "Applied skills checklist" before implementation.',
    'That checklist must name each applicable skill, list the abstract items you will apply, state the anti-patterns you are avoiding, and define the cheap probe, stop condition, expected runtime, and log path before any long run.',
    'Before finalize_submission, write workspace/skill_application.json with schema_version: 1 and a skills array.',
    'Each exposed skill entry must include skill, status, evidence_path, and reason; status must be used, not_applicable, or blocked_but_overridden.',
    'Use evidence_path for a run-local public/workspace/logs artifact that proves the contract item was checked; do not put private paths, reference-solution paths, hidden data, or task-specific leaked constants in this file.',
    ...(visibleNames.length > 0
      ? ['Allowed active skill names:', ...visibleNames.map(name => `- ${name}`)]
      : ['Available active skills are discoverable through the Skill tool.']),
    '</active_skills>',
  ].join('\n')
}

export function userPromptBlock(userPrompt: string | undefined): string | undefined {
  const trimmed = userPrompt?.trim()
  if (!trimmed) return undefined
  return ['<user_prompt>', trimmed, '</user_prompt>'].join('\n')
}

export function runMemoryPromptBlock(memory: { path: string; content: string }): string {
  return [
    '<run_memory>',
    `path: ${memory.path}`,
    memory.content,
    '</run_memory>',
  ].join('\n')
}

export function resumeContextPromptBlock(snapshot: Partial<ResumeRunSnapshot>): string {
  const contextEvents = snapshot.contextEvents ?? []
  return [
    '<resume_context>',
    `run_dir: ${snapshot.runDir ?? '(unknown)'}`,
    `task_id: ${snapshot.taskId ?? '(unknown)'}`,
    snapshot.latestPlan ? '<latest_plan>' : undefined,
    snapshot.latestPlan?.trim(),
    snapshot.latestPlan ? '</latest_plan>' : undefined,
    snapshot.runMemory ? '<previous_run_memory>' : undefined,
    snapshot.runMemory?.trim(),
    snapshot.runMemory ? '</previous_run_memory>' : undefined,
    ...(contextEvents.length > 0
      ? [
          '<context_events>',
          ...contextEvents.map(event =>
            `- round=${event.round ?? 'unknown'} subtype=${event.subtype}${event.message ? ` message=${event.message}` : ''}`,
          ),
          '</context_events>',
        ]
      : []),
    '</resume_context>',
  ]
    .filter(Boolean)
    .join('\n')
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(stripUtf8Bom(await readFile(path, 'utf8'))) as T
  } catch {
    return undefined
  }
}

function roundPlanPath(round: number): string {
  return `workspace/plans/round_${String(round).padStart(2, '0')}.md`
}

function shouldSkipPublicPath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/')
  return (
    parts[0] === 'known_tasks' ||
    parts.includes('.venv') ||
    parts.includes('.venv-posix')
  )
}

async function collectPublicFiles(
  publicDir: string,
  currentDir = publicDir,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name)
    const relativePath = relative(publicDir, absolutePath).replace(/\\/g, '/')
    if (shouldSkipPublicPath(relativePath)) continue
    if (entry.isDirectory()) {
      files.push(...(await collectPublicFiles(publicDir, absolutePath)))
      continue
    }
    if (entry.isFile()) files.push(relativePath)
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function formatPublicFiles(files: string[]): string {
  if (files.length === 0) return '(No public files found.)'
  return files.map(file => `- ${file}`).join('\n')
}

function formatShape(shape: unknown): string {
  return Array.isArray(shape) ? `[${shape.join(',')}]` : 'unspecified'
}

function formatDtype(dtype: unknown): string {
  if (Array.isArray(dtype)) return dtype.map(String).join('|')
  if (typeof dtype === 'string') return dtype
  return 'unspecified'
}

function buildOutputContract(schema: OutputSchema | undefined): string {
  if (!schema) {
    return 'Output schema summary unavailable. Read public/output_schema.json if needed.'
  }
  const pattern =
    schema.submission?.path_template ?? schema.path_template ?? 'outputs/{case_id}.npz'
  const lines = [`Required file pattern: ${pattern}`, 'Required arrays:']
  const arrays = schema.arrays ?? []
  if (arrays.length === 0) {
    lines.push('- (No array requirements found in output_schema.json.)')
  } else {
    const finite = schema.validation?.finite_only === false ? '' : ', finite'
    for (const item of arrays) {
      lines.push(
        `- ${item.key ?? '(unnamed)'}: shape ${formatShape(item.shape)}, dtype ${formatDtype(item.dtype)}${finite}`,
      )
    }
  }
  return lines.join('\n')
}

function buildVisibleCases(cases: CasesConfig | undefined): string {
  const items = cases?.cases ?? []
  if (items.length === 0) return '(No visible cases listed.)'
  return items
    .map(item =>
      [
        `- ${item.id ?? '(unknown_case)'}:`,
        item.input_dir ? `  input_dir: ${item.input_dir}` : undefined,
        item.params ? `  params: ${item.params}` : undefined,
        item.expected_output ? `  expected_output: ${item.expected_output}` : undefined,
        item.description ? `  description: ${item.description}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')
}

export function buildSourceSystemPrompt(
  extra?: string,
  _options?: SourcePromptPolicyOptions,
): string {
  return [
    'You are an autonomous solver inside a source-native evaluation harness.',
    '',
    'Goal: produce valid final submission files for the current public task.',
    '',
    'Use only run-local paths:',
    '- public/: read-only public task data.',
    '- workspace/: writable scratch, plans, and solver code.',
    '- outputs/: writable final submission files.',
    '- logs/agent/: optional notes.',
    '',
    'Do not access private judge data, original task directories, other runs, parent directories, home directories, or system secrets.',
    '',
    'Use the provided Python runtime. Do not install packages or create/repair environments.',
    '',
    'Planning discipline:',
    '- You may inspect necessary public files before planning.',
    '- For each judge round, once you understand the task and any judge feedback, write a detailed, task-specific plan before implementation, long computation, or submission.',
    '- Write the round plan to workspace/plans/round_NN.md and copy the current round plan to workspace/plan.md.',
    '- The plan should be as detailed as needed: include task understanding, public data observations, assumptions, algorithm strategy, validation strategy, risks, and concrete execution steps.',
    '- Avoid generic filler. Every plan section should contain information specific to this task or this judge feedback.',
    '- workspace/plans/round_NN.md and workspace/plan.md are the authoritative plan artifacts; do not replace them with TodoWrite items.',
    '- You may use TodoWrite as an in-turn working-memory checklist (e.g. tracking which experiments have been run, which files still need to be regenerated). Treat TodoWrite as scratchpad, not as the round plan.',
    '',
    'Round closure discipline:',
    '- Judge feedback is more valuable than private speculation. Prefer submitting a valid best attempt over running open-ended experiments.',
    '- In each judge round, run only a small set of focused experiments, then select the best solver, regenerate outputs/, validate the file format, and call finalize_submission.',
    '- If you believe outputs/ already contains files matching the output contract, submit the best available valid output instead of continuing unbounded exploration.',
    '',
    'Experiment discipline:',
    '- Put non-trivial Python experiments in workspace/experiments/*.py or workspace/*.py.',
    '- Do not put long Python programs in Bash python -c; Bash should run scripts or short validation commands.',
    '- For long Python runs, prefer python -u with an explicit timeout and log path so progress is observable.',
    '- Before starting a long run, check whether the same experiment is already running; do not launch duplicate long-running processes.',
    '',
    'When final output files exist under outputs/, call finalize_submission. A text answer is not a submission.',
    extra?.trim(),
  ]
    .filter(Boolean)
    .join('\n')
}

export async function buildInitialSourcePrompt(input: {
  taskRun: TaskRun
  runtime: RuntimeInfo
  userTask: string
  maxRounds: number
  hasKnownTaskMaterials?: boolean
  knownTaskMaterialsDeepRead?: boolean
  hasActiveSkills?: boolean
  activeSkillNames?: string[]
  networkPolicy?: EvaluationNetworkPolicy
  agentToolAvailable?: boolean
  userPrompt?: string
  runMemory?: { path: string; content: string }
  resumeContext?: Partial<ResumeRunSnapshot>
}): Promise<string> {
  const { taskRun, runtime, userTask, maxRounds } = input
  const [publicFiles, schema, cases] = await Promise.all([
    collectPublicFiles(taskRun.publicDir),
    readJsonIfExists<OutputSchema>(join(taskRun.publicDir, 'output_schema.json')),
    readJsonIfExists<CasesConfig>(join(taskRun.publicDir, 'visible_data', 'cases.json')),
  ])

  return [
    '<run_context>',
    `task_id: ${taskRun.taskId}`,
    'cwd: run root',
    `python: ${runtime.displayPath}`,
    `max_judge_rounds: ${maxRounds}`,
    'submission_dir: outputs/',
    'current_plan_file: workspace/plan.md',
    `round_plan_file: ${roundPlanPath(1)}`,
    '</run_context>',
    '',
    '<public_files>',
    formatPublicFiles(publicFiles),
    '</public_files>',
    '',
    '<task_statement>',
    userTask.trim() || '(No README.md content was found; inspect public/.)',
    '</task_statement>',
    '',
    '<output_contract>',
    buildOutputContract(schema),
    '</output_contract>',
    '',
    '<visible_cases>',
    buildVisibleCases(cases),
    '</visible_cases>',
    '',
    ...(userPromptBlock(input.userPrompt)
      ? [userPromptBlock(input.userPrompt)!, '']
      : []),
    ...(input.hasKnownTaskMaterials
      ? [knownTaskMaterialsPromptBlock(input.knownTaskMaterialsDeepRead), '']
      : []),
    ...(input.hasActiveSkills
      ? [activeSkillsPromptBlock(input.activeSkillNames), '']
      : []),
    ...(input.runMemory ? [runMemoryPromptBlock(input.runMemory), ''] : []),
    ...(input.resumeContext ? [resumeContextPromptBlock(input.resumeContext), ''] : []),
    '<workflow>',
    '1. Use <output_contract> and <visible_cases> as the submission contract. Inspect relevant public case input files for raw keys, shapes, dtypes, finite status, and value ranges before choosing a solver; do not assume array structure.',
    '2. Treat public README/case params/metadata as authoritative for solver budgets and task constants; do not reuse older defaults from memory, skills, or prior runs when they conflict with current public files.',
    `3. Once you understand the task, write ${roundPlanPath(1)} and refresh workspace/plan.md.`,
    '4. Before long optimization or simulation, record the public parameter source, planned count, observed per-iteration time, total runtime estimate, stop condition, and log path in the round plan.',
    '5. Write solver code under workspace/ and longer experiments under workspace/experiments/.',
    '6. Use Bash for short commands or to run scripts; do not use long inline python -c programs.',
    '7. Run a bounded set of focused experiments, then choose the best current solver.',
    '8. Write final submission files under outputs/ and run a quick local format check against <output_contract>.',
    '9. Call finalize_submission. The judge feedback is more valuable than private speculation.',
    '</workflow>',
  ].join('\n')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function compactJudgeFeedback(judgeResult: JudgeResult): CompactJudgeFeedback {
  const raw = judgeResult.raw as
    | {
        cases?: Array<{
          reason?: unknown
          format?: { status?: unknown }
          metrics?: Array<{ name?: unknown; status?: unknown }>
        }>
      }
    | undefined
  const cases = raw && typeof raw === 'object' && Array.isArray(raw.cases) ? raw.cases : []
  if (cases.length === 0) {
    return {
      format: 'unknown',
      reasons: [],
      failedMetrics: [],
      passedMetrics: [],
      message: judgeResult.feedback || '(no feedback)',
    }
  }

  const formatStatuses = unique(
    cases.map(item => String(item.format?.status ?? 'unknown')),
  )
  const reasons = unique(cases.map(item => String(item.reason ?? '')).filter(Boolean))
  const metrics = cases.flatMap(item => item.metrics ?? [])
  return {
    format: formatStatuses.length === 1 ? formatStatuses[0] : formatStatuses.join('|'),
    reasons,
    failedMetrics: unique(
      metrics
        .filter(item => item.status === 'fail')
        .map(item => String(item.name ?? '(unnamed_metric)')),
    ),
    passedMetrics: unique(
      metrics
        .filter(item => item.status === 'pass')
        .map(item => String(item.name ?? '(unnamed_metric)')),
    ),
  }
}

function formatList(label: string, values: string[]): string[] {
  if (values.length === 0) return [`${label}: []`]
  return [`${label}:`, ...values.map(value => `- ${value}`)]
}

export function buildJudgeFeedbackPrompt(input: {
  round: number
  maxRounds: number
  judgeResult: JudgeResult
  hasActiveSkills?: boolean
  activeSkillNames?: string[]
  userPrompt?: string
  runMemory?: { path: string; content: string }
}): string {
  const { round, maxRounds, judgeResult } = input
  const nextRound = round + 1
  const compact = compactJudgeFeedback(judgeResult)
  return [
    '<judge_feedback>',
    `round: ${round}/${maxRounds}`,
    `status: ${judgeResult.status}`,
    `reward: ${judgeResult.reward}`,
    `format: ${compact.format}`,
    `reason: ${compact.reasons.join('|') || 'none'}`,
    ...formatList('failed_metrics', compact.failedMetrics),
    ...formatList('passed_metrics', compact.passedMetrics),
    ...(compact.message ? [`message: ${compact.message}`] : []),
    '</judge_feedback>',
    '',
    ...(userPromptBlock(input.userPrompt)
      ? [userPromptBlock(input.userPrompt)!, '']
      : []),
    ...(input.hasActiveSkills
      ? [activeSkillsPromptBlock(input.activeSkillNames), '']
      : []),
    ...(input.runMemory ? [runMemoryPromptBlock(input.runMemory), ''] : []),
    '<workflow>',
    `Before modifying code for this feedback, understand the feedback, then write ${roundPlanPath(nextRound)} and refresh workspace/plan.md.`,
    ...(input.hasActiveSkills
      ? ['Start the next plan by re-reading Skill and explaining which skill contract item failed, was ignored, or was disproved by the judge feedback.']
      : []),
    'Make one focused fix or a small bounded experiment set, validate again, regenerate outputs, then submit the best current output to the judge with finalize_submission.',
    'Before finalize_submission, revalidate outputs against the same contract.',
    'Use workspace/experiments/*.py for longer probes; do not put long Python programs in Bash python -c.',
    '</workflow>',
  ].join('\n')
}

export function buildPromptTooLongRecoveryPrompt(input: {
  round: number
  maxRounds: number
  judgeResult?: JudgeResult
  hasActiveSkills?: boolean
  activeSkillNames?: string[]
  userPrompt?: string
  runMemory?: { path: string; content: string }
}): string {
  const compact = input.judgeResult
    ? compactJudgeFeedback(input.judgeResult)
    : undefined
  return [
    '<prompt_too_long_recovery>',
    `round: ${input.round}/${input.maxRounds}`,
    'The previous source-agent session exceeded the model prompt/context limit.',
    'Continue in this fresh session from run-local artifacts instead of replaying the bloated conversation.',
    'Do not restart broad exploration. Read workspace/plan.md, workspace/plans/, workspace/agent_memory.md, logs/agent/, and public/ only as needed to recover the current state.',
    'If outputs/ already contains valid candidate files, prefer validating and calling finalize_submission over new open-ended work.',
    ...(compact
      ? [
          '<latest_judge_feedback>',
          `status: ${input.judgeResult?.status}`,
          `reward: ${input.judgeResult?.reward}`,
          `format: ${compact.format}`,
          `reason: ${compact.reasons.join('|') || 'none'}`,
          ...formatList('failed_metrics', compact.failedMetrics),
          ...formatList('passed_metrics', compact.passedMetrics),
          ...(compact.message ? [`message: ${compact.message}`] : []),
          '</latest_judge_feedback>',
        ]
      : []),
    '</prompt_too_long_recovery>',
    '',
    ...(userPromptBlock(input.userPrompt)
      ? [userPromptBlock(input.userPrompt)!, '']
      : []),
    ...(input.hasActiveSkills
      ? [activeSkillsPromptBlock(input.activeSkillNames), '']
      : []),
    ...(input.runMemory ? [runMemoryPromptBlock(input.runMemory), ''] : []),
    '<workflow>',
    '1. Reconstruct only the minimum current state needed for this round.',
    '2. Prefer implementation/contract error checks over optimizer-detail tuning.',
    '3. Make one focused fix or submit the best currently valid outputs.',
    '4. Revalidate outputs against the public output contract, then call finalize_submission.',
    '</workflow>',
  ].join('\n')
}

export function buildNoFinalizeRecoveryPrompt(input: {
  round: number
  maxRounds: number
}): string {
  return [
    '<no_finalize_recovery>',
    `round: ${input.round}/${input.maxRounds}`,
    'Your previous turn ended without finalize_submission.',
    'Do not start new open-ended research or long experiments.',
    'If you believe outputs/ contains valid final files, call finalize_submission now with a concise summary.',
    'If outputs/ is missing or invalid, make only the shortest necessary format fix, then call finalize_submission.',
    'If you cannot create a valid output, briefly explain the blocker and stop.',
    '</no_finalize_recovery>',
  ].join('\n')
}
