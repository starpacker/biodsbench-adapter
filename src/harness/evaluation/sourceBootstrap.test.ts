import { describe, expect, test } from 'bun:test'
import { ensureSourceRuntimeGlobals } from './sourceBootstrap.js'

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe('ensureSourceRuntimeGlobals', () => {
  test('defines source MACRO globals needed by unbundled Claude source', () => {
    ensureSourceRuntimeGlobals()
    const macro = (globalThis as unknown as { MACRO?: { VERSION?: string } }).MACRO
    expect(macro?.VERSION).toBeTruthy()
  })

  test('maps generic local gateway env names to Claude source env names', () => {
    const oldApiKey = process.env.ANTHROPIC_API_KEY
    const oldBaseUrl = process.env.ANTHROPIC_BASE_URL
    const oldSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    const oldOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_BASE_URL
      delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      process.env.API_KEY = 'test-key'
      process.env.BASE_URL = 'https://example.invalid'
      process.env.MODEL_NAME = 'test-model'

      ensureSourceRuntimeGlobals()

      expect(process.env.ANTHROPIC_API_KEY).toBe('test-key')
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://example.invalid')
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('test-model')
      expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('test-model')
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', oldApiKey)
      restoreEnv('ANTHROPIC_BASE_URL', oldBaseUrl)
      restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', oldSonnet)
      restoreEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', oldOpus)
      delete process.env.API_KEY
      delete process.env.BASE_URL
      delete process.env.MODEL_NAME
    }
  })

  test('local gateway env names override stale Claude source env names', () => {
    const oldApiKey = process.env.ANTHROPIC_API_KEY
    const oldBaseUrl = process.env.ANTHROPIC_BASE_URL
    const oldSonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    const oldOpus = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    try {
      process.env.ANTHROPIC_API_KEY = 'stale-key'
      process.env.ANTHROPIC_BASE_URL = 'https://stale.invalid'
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'stale-sonnet'
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'stale-opus'
      process.env.API_KEY = 'local-key'
      process.env.BASE_URL = 'https://local.invalid'
      process.env.MODEL_NAME = 'local-model'

      ensureSourceRuntimeGlobals()

      expect(process.env.ANTHROPIC_API_KEY).toBe('local-key')
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://local.invalid')
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('local-model')
      expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('local-model')
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', oldApiKey)
      restoreEnv('ANTHROPIC_BASE_URL', oldBaseUrl)
      restoreEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', oldSonnet)
      restoreEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', oldOpus)
      delete process.env.API_KEY
      delete process.env.BASE_URL
      delete process.env.MODEL_NAME
    }
  })
})
