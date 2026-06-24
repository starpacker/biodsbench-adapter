import type { EvaluationLlmOptions, EvaluationRunMetadata } from './types.js'

export type RunMetadataCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<string>

export type CollectRunMetadataInput = {
  llmOptions?: EvaluationLlmOptions
  env?: Record<string, string | undefined>
  cwd?: string
  runCommand?: RunMetadataCommandRunner
}

const DEFAULT_LLM_OPTIONS: EvaluationLlmOptions = {
  temperature: 1,
  thinking: 'disabled',
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find(Boolean)
}

export function parseBaseUrlHost(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      return new URL(candidate).host || null
    } catch {
      // Try the next shape; BASE_URL is sometimes configured without a scheme.
    }
  }
  const host = raw.split(/[/?#]/, 1)[0]
  return host || null
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command} ${args.join(' ')} failed`)
  }
  return stdout
}

async function collectGitMetadata(
  runCommand: RunMetadataCommandRunner,
  cwd: string,
): Promise<Pick<EvaluationRunMetadata, 'git_commit' | 'git_dirty'>> {
  let gitCommit = 'unknown'
  let gitDirty: boolean | null = null

  try {
    const output = await runCommand('git', ['rev-parse', 'HEAD'], { cwd })
    gitCommit = output.trim() || 'unknown'
  } catch {
    gitCommit = 'unknown'
  }

  try {
    const output = await runCommand('git', ['status', '--porcelain'], { cwd })
    gitDirty = output.trim().length > 0
  } catch {
    gitDirty = null
  }

  return { git_commit: gitCommit, git_dirty: gitDirty }
}

export async function collectRunMetadata(
  input: CollectRunMetadataInput = {},
): Promise<EvaluationRunMetadata> {
  const env = input.env ?? process.env
  const llmOptions = input.llmOptions ?? DEFAULT_LLM_OPTIONS
  const runCommand = input.runCommand ?? defaultRunCommand
  const git = await collectGitMetadata(runCommand, input.cwd ?? process.cwd())
  const temperatureIgnored = llmOptions.thinking === 'adaptive'

  return {
    model:
      firstNonEmpty(
        env.MODEL_NAME,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      ) ?? 'unknown',
    base_url_host: parseBaseUrlHost(env.BASE_URL),
    ...git,
    temperature_configured: llmOptions.temperature,
    temperature_sent: temperatureIgnored ? null : llmOptions.temperature,
    temperature_ignored: temperatureIgnored,
    temperature_ignored_reason: temperatureIgnored ? 'thinking_mode_adaptive' : null,
    thinking_mode: llmOptions.thinking,
    thinking_budget_tokens: null,
  }
}
