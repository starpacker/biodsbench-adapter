import type {
  EvaluationContextOptions,
  EvaluationNetworkPolicy,
} from './types.js'

export const DEFAULT_EVALUATION_NETWORK_POLICY: EvaluationNetworkPolicy = 'disabled'

export type EvaluationNetworkPolicyOptions = Partial<
  Pick<EvaluationContextOptions, 'networkPolicy' | 'enableAgentTool'>
>

export function normalizeEvaluationNetworkPolicy(
  policy: EvaluationNetworkPolicy | undefined,
): EvaluationNetworkPolicy {
  return policy ?? DEFAULT_EVALUATION_NETWORK_POLICY
}

export function isEvaluationNetworkDisabled(
  options?: Pick<EvaluationNetworkPolicyOptions, 'networkPolicy'>,
): boolean {
  return normalizeEvaluationNetworkPolicy(options?.networkPolicy) === 'disabled'
}

export function canUseEvaluationAgentTool(
  options?: EvaluationNetworkPolicyOptions,
): boolean {
  return (
    normalizeEvaluationNetworkPolicy(options?.networkPolicy) === 'enabled' &&
    options?.enableAgentTool === true
  )
}

export function isEvaluationNetworkToolName(name: string): boolean {
  return (
    name === 'WebSearch' ||
    name === 'WebFetch' ||
    name.startsWith('CompatWebSearch') ||
    name.startsWith('CompatWebFetch')
  )
}

export function validateEvaluationNetworkPolicy(
  options: EvaluationNetworkPolicyOptions | undefined,
  path = 'contextOptions',
): void {
  if (
    normalizeEvaluationNetworkPolicy(options?.networkPolicy) === 'disabled' &&
    options?.enableAgentTool === true
  ) {
    throw new Error(
      `${path}: networkPolicy disabled cannot enable AgentTool; set networkPolicy to enabled or disable AgentTool.`,
    )
  }
}
