import type { ThinkingConfig } from '../../utils/thinking.js'
import type { EvaluationLlmOptions } from './types.js'

export type SourceLlmQueryOptions = {
  thinkingConfig: ThinkingConfig
  temperatureOverride?: number
}

export function buildSourceLlmQueryOptions(
  options: EvaluationLlmOptions | undefined,
): SourceLlmQueryOptions {
  const llmOptions = options ?? { temperature: 1, thinking: 'disabled' as const }
  if (llmOptions.thinking === 'adaptive') {
    return {
      thinkingConfig: { type: 'adaptive' },
      temperatureOverride: undefined,
    }
  }
  return {
    thinkingConfig: { type: 'disabled' },
    temperatureOverride: llmOptions.temperature,
  }
}
