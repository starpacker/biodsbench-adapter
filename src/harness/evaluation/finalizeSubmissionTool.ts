import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import {
  formatSubmissionValidationFeedback,
  validateSubmission,
} from './submissionValidator.js'
import type {
  RuntimeInfo,
  SourceAgentEvent,
  SourceRunWarning,
  SubmissionValidationResult,
  TaskRun,
} from './types.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    summary: z.string().min(1),
    files: z.array(z.string()).default([]),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type FinalizeSubmissionState = {
  readyForJudge: boolean
  summary: string
  files: string[]
  requiredRoundPlan?: string
  validation?: SubmissionValidationResult
  warnings?: SourceRunWarning[]
  pendingEvents?: SourceAgentEvent[]
}

export type CreateFinalizeSubmissionToolInput = {
  taskRun: TaskRun
  state: FinalizeSubmissionState
  runtime?: RuntimeInfo
  requireSkillApplication?: boolean
  allowedSkillNames?: string[]
}

function isInside(path: string, parent: string): boolean {
  const child = resolve(path)
  const base = resolve(parent)
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base
  return (
    normalizedChild === normalizedBase ||
    normalizedChild.startsWith(`${normalizedBase}\\`) ||
    normalizedChild.startsWith(`${normalizedBase}/`)
  )
}

function resolveOutputFile(taskRun: TaskRun, path: string): string {
  const target = resolve(taskRun.runDir, path)
  if (!isInside(target, taskRun.outputsDir)) {
    throw new Error(
      `finalize_submission files must be paths under outputs/: ${path}`,
    )
  }
  return `outputs/${relative(taskRun.outputsDir, target).replace(/\\/g, '/')}`
}

function collectPlanWarnings(
  taskRun: TaskRun,
  requiredRoundPlan?: string,
): SourceRunWarning[] {
  const warnings: SourceRunWarning[] = []
  const currentPlan = join(taskRun.workspaceDir, 'plan.md')
  if (!existsSync(currentPlan)) {
    warnings.push({
      code: 'missing_current_plan',
      message:
        'workspace/plan.md is missing; submission was still accepted because outputs are schema-valid.',
    })
  }
  if (requiredRoundPlan) {
    const absoluteRoundPlan = resolve(taskRun.runDir, requiredRoundPlan)
    if (!isInside(absoluteRoundPlan, join(taskRun.workspaceDir, 'plans'))) {
      throw new Error(`finalize_submission has invalid required plan path: ${requiredRoundPlan}`)
    }
    if (!existsSync(absoluteRoundPlan)) {
      warnings.push({
        code: 'missing_round_plan',
        message: `${requiredRoundPlan} is missing; submission was still accepted because outputs are schema-valid.`,
        details: { path: requiredRoundPlan },
      })
    }
    return warnings
  }
  const plansDir = join(taskRun.workspaceDir, 'plans')
  const hasRoundPlan =
    existsSync(plansDir) &&
    readdirSync(plansDir).some(file => /^round_\d+\.md$/.test(file))
  if (!hasRoundPlan) {
    warnings.push({
      code: 'missing_round_plan',
      message:
        'workspace/plans/round_NN.md is missing; submission was still accepted because outputs are schema-valid.',
    })
  }
  return warnings
}

const VALID_SKILL_APPLICATION_STATUSES = new Set([
  'used',
  'not_applicable',
  'blocked_but_overridden',
])

function skillApplicationEntries(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.skills)) return undefined
  if (!raw.skills.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    return undefined
  }
  return raw.skills as Array<Record<string, unknown>>
}

function isUnsafeEvidencePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.includes('.judge_private') ||
    normalized.includes('known_tasks/')
  )
}

function collectSkillApplicationWarnings(input: {
  taskRun: TaskRun
  required?: boolean
  allowedSkillNames?: string[]
}): SourceRunWarning[] {
  if (!input.required) return []
  const relativePath = 'workspace/skill_application.json'
  const absolutePath = join(input.taskRun.workspaceDir, 'skill_application.json')
  if (!existsSync(absolutePath)) {
    return [
      {
        code: 'missing_skill_application',
        message:
          'workspace/skill_application.json is missing; submission was still accepted because outputs are schema-valid.',
        details: { path: relativePath },
      },
    ]
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(absolutePath, 'utf8'))
  } catch (error) {
    return [
      {
        code: 'invalid_skill_application',
        message:
          'workspace/skill_application.json is not valid JSON; submission was still accepted because outputs are schema-valid.',
        details: { path: relativePath, error: error instanceof Error ? error.message : String(error) },
      },
    ]
  }

  const entries = skillApplicationEntries(parsed)
  if (!entries || entries.length === 0) {
    return [
      {
        code: 'invalid_skill_application',
        message:
          'workspace/skill_application.json must contain a non-empty skills array.',
        details: { path: relativePath },
      },
    ]
  }

  const invalidEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      const skill = entry.skill
      const status = entry.status
      const evidencePath = entry.evidence_path
      const reason = entry.reason
      return (
        typeof skill !== 'string' ||
        skill.trim().length === 0 ||
        typeof status !== 'string' ||
        !VALID_SKILL_APPLICATION_STATUSES.has(status) ||
        typeof evidencePath !== 'string' ||
        evidencePath.trim().length === 0 ||
        isUnsafeEvidencePath(evidencePath) ||
        typeof reason !== 'string' ||
        reason.trim().length === 0
      )
    })
  if (invalidEntries.length > 0) {
    return [
      {
        code: 'invalid_skill_application',
        message:
          'workspace/skill_application.json has invalid skill application entries.',
        details: {
          path: relativePath,
          invalidIndexes: invalidEntries.map(item => item.index),
        },
      },
    ]
  }

  const allowed = [...new Set(input.allowedSkillNames?.filter(Boolean) ?? [])]
  if (allowed.length > 0) {
    const covered = new Set(entries.map(entry => String(entry.skill)))
    const missing = allowed.filter(name => !covered.has(name))
    if (missing.length > 0) {
      return [
        {
          code: 'incomplete_skill_application',
          message:
            'workspace/skill_application.json does not cover every exposed active skill.',
          details: { path: relativePath, missingSkillNames: missing },
        },
      ]
    }
  }

  return []
}

function pushPendingEvent(state: FinalizeSubmissionState, event: SourceAgentEvent): void {
  state.pendingEvents ??= []
  state.pendingEvents.push(event)
}

export function createFinalizeSubmissionTool(input: CreateFinalizeSubmissionToolInput) {
  const { taskRun, state, runtime } = input
  return buildTool({
    name: 'finalize_submission',
    searchHint: 'signal final task outputs are ready for judge',
    maxResultSizeChars: 4096,
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    async description() {
      return 'Signal that final outputs are ready for the external judge.'
    },
    async prompt() {
      return [
        'Call this exactly when your final output files are ready for the external judge.',
        'workspace/plan.md and workspace/plans/round_NN.md should already exist; missing plan files become warnings, not hard blockers.',
        ...(input.requireSkillApplication
          ? ['workspace/skill_application.json should record how active skill contracts were applied; missing or invalid files become warnings, not hard blockers.']
          : []),
        'All files must exist under outputs/.',
        'The harness validates outputs against the public output schema before judge runs.',
        'Arguments: summary and files.',
      ].join(' ')
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    async call(args) {
      const warnings = [
        ...collectPlanWarnings(taskRun, state.requiredRoundPlan),
        ...collectSkillApplicationWarnings({
          taskRun,
          required: input.requireSkillApplication,
          allowedSkillNames: input.allowedSkillNames,
        }),
      ]
      for (const file of args.files) resolveOutputFile(taskRun, file)
      const validation = await validateSubmission({
        taskRun,
        runtime,
        files: args.files,
      })
      state.validation = validation
      state.warnings = warnings
      for (const warning of warnings) {
        pushPendingEvent(state, {
          type: 'run_warning',
          code: warning.code,
          message: warning.message,
          details: warning.details,
        })
      }
      if (!validation.ok) {
        state.readyForJudge = false
        state.summary = ''
        state.files = []
        pushPendingEvent(state, {
          type: 'submission_validation_failed',
          result: validation,
        })
        return {
          data: formatSubmissionValidationFeedback(validation),
        }
      }
      state.readyForJudge = true
      state.summary = args.summary
      state.files = validation.normalizedFiles
      pushPendingEvent(state, {
        type: 'submission_validation_passed',
        result: validation,
      })
      return {
        data: [
          `Submission finalized: ${args.summary}`,
          ...warnings.map(warning => `Warning: ${warning.message}`),
        ].join('\n'),
      }
    },
    async checkPermissions(args): Promise<PermissionResult> {
      return {
        behavior: 'allow',
        updatedInput: args,
        decisionReason: {
          type: 'other',
          reason: 'finalize_submission is controlled by the harness',
        },
      }
    },
    renderToolUseMessage(args) {
      return `finalize_submission: ${args.summary}`
    },
    renderToolUseRejectedMessage() {
      return 'finalize_submission rejected'
    },
    renderToolUseErrorMessage(result) {
      return String(result)
    },
    renderToolResultMessage(output) {
      return output
    },
    mapToolResultToToolResultBlockParam(content, toolUseID) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseID,
        content,
      }
    },
  } satisfies ToolDef<InputSchema, string>)
}
