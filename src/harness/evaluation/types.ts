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

export type EvaluationLlmOptions = {
  temperature: number
  thinking: EvaluationThinkingMode
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
  llmOptions?: EvaluationLlmOptions
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

/**
 * Information about one already-completed sub-task in a serial evaluation
 * run. The orchestrator (e.g. `run_imaging101_*_serial.py`) feeds these
 * records into the next sub-task's initial prompt so the model can build
 * on shared analysis instead of re-deriving everything from scratch.
 */
export type PriorSubtaskContext = {
  /** Sub-task identifier (e.g. "25303977_3"). */
  taskId: string
  /** Sequence index within the serial run. */
  taskIdx?: number
  /** Final loop status of that sub-task ("success" | "failed" | "timeout"). */
  status?: string
  /** Whether the sub-task ultimately passed judge. */
  passed?: boolean
  /** Free-form task statement (typically the README.md of the sub-task). */
  description?: string
  /** Final solver code that produced the accepted submission (truncated by orchestrator if huge). */
  generatedCode?: string
  /** Last judge feedback for this sub-task, if any (helps the model avoid repeating mistakes). */
  judgeFeedback?: string
  /** Optional short notes the orchestrator wants to surface (e.g. derived data shapes). */
  notes?: string
}

export type RunSourceTaskLoopInput = {
  taskId: string
  tasksDir?: string
  runsDir?: string
  maxRounds: number
  maxTurnsPerRound?: number
  timeoutSeconds: number
  timestamp?: string
  systemPrompt?: string
  verbose?: boolean
  llmOptions?: EvaluationLlmOptions
  sessionFactory?: SourceSessionFactory
  sessionDisposeGraceMs?: number
  judge: JudgeRunner
  /** Optional prior sub-task context for true-serial evaluation. */
  priorSubtasks?: PriorSubtaskContext[]
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
