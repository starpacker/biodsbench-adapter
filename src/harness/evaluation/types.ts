export type LoopStatus = 'success' | 'failed' | 'timeout' | 'infra_error'
export type JudgeStatus = 'pass' | 'fail' | 'error'

export type TaskRun = {
  taskId: string
  runId: string
  runDir: string
  judgeDir: string
  publicDir: string
  workspaceDir: string
  outputsDir: string
  logsDir: string
  taskDir: string
  manifest: TaskManifest
}

export type TaskManifest = {
  version: number
  task_id: string
  public_bundle?: string[]
  private_judge_bundle?: string[]
  entrypoints?: {
    judge?: string
    cases?: string
    output_schema?: string
    metrics?: string
    environment?: string
  }
  submission?: {
    output_dir?: string
    path_template?: string
  }
}

export type JudgeResult = {
  status: JudgeStatus
  reward: number
  feedback: string
  raw: unknown
  resultPath?: string
  stdout?: string
  stderr?: string
}

export type RuntimeInfo = {
  python: string
  displayPath: string
  envName: string
}

export type RuntimeResolution =
  | (RuntimeInfo & {
      ok: true
      checked: string[]
    })
  | {
      ok: false
      error: string
      checked: string[]
    }

export type EvaluationThinkingMode = 'disabled' | 'adaptive'
export type EvaluationNetworkPolicy = 'disabled' | 'enabled'

export type JudgeFeedbackLevel =
  | 'overall_only'
  | 'case_only'
  | 'metric_status'
  | 'metric_value'
  | 'metric_full'

export type EvaluationLlmOptions = {
  temperature: number
  thinking: EvaluationThinkingMode
}

export type EvaluationContextProfile =
  | 'eval-minimal'
  | 'eval-safe-claude-parity'
  | 'full-claude-unsafe'

export type EvaluationContextOptions = {
  profile: EvaluationContextProfile
  runMemory: boolean
  resumeRun?: string
  recordContextEvents: boolean
  reInjectActiveSkillsEachRound: boolean
  includeClaudeDefaultUserContext: boolean
  enableSlashCommands: boolean
  enableMcpClients: boolean
  networkPolicy: EvaluationNetworkPolicy
  enableAgentTool: boolean
  disableAutoCompact?: boolean
}

export type EvaluationSkillOptions = {
  enabled: boolean
  skillsDir: string
  additionalSkillsDirs?: string[]
  allowedSkillNames?: string[]
  mode: 'native'
  maxActiveSkills?: number
}

export type KnownTaskMaterialsOptions = {
  enabled: boolean
  sourceTaskIds: string[]
  deepRead?: boolean
}

export type KnownTaskMaterialsAudit = {
  enabled: boolean
  copied: Array<{ sourceTaskId: string; files: string[] }>
  skipped: Array<{ sourceTaskId: string; file: string; reason: string }>
}

export type EvaluationRunMetadata = {
  model: string
  base_url_host: string | null
  git_commit: string
  git_dirty: boolean | null
  temperature_configured: number
  temperature_sent: number | null
  temperature_ignored: boolean
  temperature_ignored_reason: string | null
  thinking_mode: EvaluationThinkingMode
  thinking_budget_tokens: null
}

export type SubmissionValidationIssue = {
  code:
    | 'missing_output_file'
    | 'path_outside_outputs'
    | 'missing_array_key'
    | 'shape_mismatch'
    | 'dtype_mismatch'
    | 'non_finite_values'
    | 'schema_read_failed'
    | 'cases_read_failed'
    | 'npz_read_failed'
    | 'validator_runtime_failed'
  path?: string
  key?: string
  message: string
  details?: unknown
}

export type SubmissionValidationResult = {
  ok: boolean
  normalizedFiles: string[]
  issues: SubmissionValidationIssue[]
}

export type SourceRunWarning = {
  code: string
  message: string
  details?: unknown
}

export type SourceAgentStartInput = {
  taskRun: TaskRun
  maxRounds: number
  maxTurnsPerRound?: number
  userTask: string
  runtime: RuntimeInfo
  systemPrompt?: string
  userPrompt?: string
  llmOptions?: EvaluationLlmOptions
  skillOptions?: EvaluationSkillOptions
  contextOptions?: EvaluationContextOptions
}

export type SourceAgentTurnInput = {
  taskRun: TaskRun
  round: number
  maxRounds: number
  maxTurnsPerRound?: number
  prompt: string
  runtime: RuntimeInfo
}

export type JudgeRunInput = {
  taskRun: TaskRun
  runtime: RuntimeInfo
  round: number
  timeoutSeconds: number
  feedbackLevel?: JudgeFeedbackLevel
}

export type JudgeRunner = {
  run(input: JudgeRunInput): Promise<JudgeResult>
}

export type SourceAgentEvent =
  | {
      type: 'assistant_text'
      text: string
      raw?: unknown
    }
  | {
      type: 'assistant_thinking'
      text: string
      signature?: string
      raw?: unknown
    }
  | {
      type: 'tool_call'
      tool: string
      input?: unknown
      toolUseId?: string
      raw?: unknown
    }
  | {
      type: 'tool_result'
      toolUseId?: string
      ok: boolean
      text?: string
      raw?: unknown
    }
  | {
      type: 'policy_deny'
      tool: string
      reason: string
      input?: unknown
    }
  | {
      type: 'trajectory_warning'
      code: string
      message: string
      details?: unknown
    }
  | {
      type: 'run_warning'
      code: string
      message: string
      details?: unknown
    }
  | {
      type: 'submission_validation_failed'
      result: SubmissionValidationResult
    }
  | {
      type: 'submission_validation_passed'
      result: SubmissionValidationResult
    }
  | {
      type: 'agent_result'
      subtype?: string
      stopReason?: string | null
      durationMs?: number
      durationApiMs?: number
      isError?: boolean
      usage?: unknown
      errors?: string[]
      raw?: unknown
    }
  | {
      type: 'context_event'
      subtype: string
      message?: string
      usage?: unknown
      metadata?: unknown
      raw?: unknown
    }
  | {
      type: 'finalize'
      summary: string
      files: string[]
      raw?: unknown
    }

export type SourceAgentSession = {
  submit(input: SourceAgentTurnInput): AsyncGenerator<SourceAgentEvent, void, unknown>
  interrupt?(reason?: string): void
  dispose?(): Promise<void>
}

export type SourceSessionFactoryInput = SourceAgentStartInput

export type SourceSessionFactory = (
  input: SourceSessionFactoryInput,
) => Promise<SourceAgentSession>

export type RunSourceTaskLoopInput = {
  taskId: string
  tasksDir?: string
  runsDir?: string
  maxRounds: number
  maxTurnsPerRound?: number
  timeoutSeconds: number
  timestamp?: string
  systemPrompt?: string
  userPrompt?: string
  verbose?: boolean
  llmOptions?: EvaluationLlmOptions
  skillOptions?: EvaluationSkillOptions
  contextOptions?: EvaluationContextOptions
  knownTaskMaterials?: KnownTaskMaterialsOptions
  judgeFeedbackLevel?: JudgeFeedbackLevel
  sessionFactory?: SourceSessionFactory
  sessionDisposeGraceMs?: number
  judge: JudgeRunner
}

export type RunSourceTaskLoopResult = {
  status: LoopStatus
  rounds: number
  reward: number
  run: TaskRun
  trajectoryPath: string
  lastJudgeResult?: JudgeResult
  finalResult?: unknown
}
