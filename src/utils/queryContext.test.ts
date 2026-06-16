import { describe, expect, test } from 'bun:test'
import { fetchSystemPromptParts } from './queryContext.js'

describe('fetchSystemPromptParts', () => {
  test('can skip default user context for source-native eval runs', async () => {
    const parts = await fetchSystemPromptParts({
      tools: [],
      mainLoopModel: 'claude-sonnet-4-5',
      additionalWorkingDirectories: [],
      mcpClients: [],
      customSystemPrompt: 'custom eval prompt',
      includeDefaultUserContext: false,
    })

    expect(parts.userContext).toEqual({})
    expect(parts.systemContext).toEqual({})
    expect(parts.defaultSystemPrompt).toEqual([])
  })
})
