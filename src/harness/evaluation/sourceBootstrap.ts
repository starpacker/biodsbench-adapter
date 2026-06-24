const DEFAULT_SOURCE_MACRO = {
  VERSION: process.env.CLAUDE_CODE_SOURCE_VERSION ?? '999.0.0',
  BUILD_TIME: process.env.CLAUDE_CODE_SOURCE_BUILD_TIME ?? '',
  PACKAGE_URL: process.env.CLAUDE_CODE_SOURCE_PACKAGE_URL ?? '@anthropic-ai/claude-code',
  NATIVE_PACKAGE_URL:
    process.env.CLAUDE_CODE_SOURCE_NATIVE_PACKAGE_URL ?? '@anthropic-ai/claude-code',
  FEEDBACK_CHANNEL:
    process.env.CLAUDE_CODE_SOURCE_FEEDBACK_CHANNEL ??
    'https://github.com/anthropics/claude-code/issues',
  ISSUES_EXPLAINER:
    process.env.CLAUDE_CODE_SOURCE_ISSUES_EXPLAINER ??
    'file an issue at https://github.com/anthropics/claude-code/issues',
  VERSION_CHANGELOG: process.env.CLAUDE_CODE_SOURCE_VERSION_CHANGELOG ?? '',
}

export function ensureSourceRuntimeGlobals(): void {
  if (process.env.API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.API_KEY
  }
  if (process.env.BASE_URL) {
    process.env.ANTHROPIC_BASE_URL = process.env.BASE_URL
  }
  if (process.env.MODEL_NAME) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.MODEL_NAME
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = process.env.MODEL_NAME
  }
  if ('MACRO' in globalThis) return
  Object.defineProperty(globalThis, 'MACRO', {
    configurable: true,
    value: DEFAULT_SOURCE_MACRO,
    writable: false,
  })
}

ensureSourceRuntimeGlobals()
