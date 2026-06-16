import { describe, expect, test } from 'bun:test'
import { collectRunMetadata } from './runMetadata.js'

describe('collectRunMetadata', () => {
  test('records safe model, base URL host, git state, and disabled-thinking temperature', async () => {
    const commands: string[] = []
    const metadata = await collectRunMetadata({
      cwd: '/repo',
      env: {
        MODEL_NAME: 'claude-test',
        BASE_URL: 'https://gateway.example.com/v1/messages?api_key=secret',
      },
      llmOptions: { temperature: 0.75, thinking: 'disabled' },
      runCommand: async (command, args) => {
        commands.push([command, ...args].join(' '))
        if (args.join(' ') === 'rev-parse HEAD') return 'abc123\n'
        if (args.join(' ') === 'status --porcelain') return ' M file.ts\n'
        throw new Error('unexpected command')
      },
    })

    expect(metadata).toEqual({
      model: 'claude-test',
      base_url_host: 'gateway.example.com',
      git_commit: 'abc123',
      git_dirty: true,
      temperature_configured: 0.75,
      temperature_sent: 0.75,
      temperature_ignored: false,
      temperature_ignored_reason: null,
      thinking_mode: 'disabled',
      thinking_budget_tokens: null,
    })
    expect(commands).toEqual(['git rev-parse HEAD', 'git status --porcelain'])
  })

  test('does not leak URL path/query and soft-fails git metadata for adaptive thinking', async () => {
    const metadata = await collectRunMetadata({
      env: {
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'default-sonnet',
        BASE_URL: 'gateway.internal.local/v1/messages?token=secret',
      },
      llmOptions: { temperature: 1, thinking: 'adaptive' },
      runCommand: async () => {
        throw new Error('git unavailable')
      },
    })

    expect(metadata.model).toBe('default-sonnet')
    expect(metadata.base_url_host).toBe('gateway.internal.local')
    expect(metadata.git_commit).toBe('unknown')
    expect(metadata.git_dirty).toBe(null)
    expect(metadata.temperature_configured).toBe(1)
    expect(metadata.temperature_sent).toBe(null)
    expect(metadata.temperature_ignored).toBe(true)
    expect(metadata.temperature_ignored_reason).toBe('thinking_mode_adaptive')
    expect(metadata.thinking_mode).toBe('adaptive')
  })
})
