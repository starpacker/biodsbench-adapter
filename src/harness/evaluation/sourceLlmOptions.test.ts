import { describe, expect, test } from 'bun:test'
import { buildSourceLlmQueryOptions } from './sourceLlmOptions.js'

describe('buildSourceLlmQueryOptions', () => {
  test('sends temperature only when thinking is disabled', () => {
    expect(buildSourceLlmQueryOptions(undefined)).toEqual({
      thinkingConfig: { type: 'disabled' },
      temperatureOverride: 1,
    })

    expect(
      buildSourceLlmQueryOptions({
        temperature: 0.5,
        thinking: 'disabled',
      }),
    ).toEqual({
      thinkingConfig: { type: 'disabled' },
      temperatureOverride: 0.5,
    })

    expect(
      buildSourceLlmQueryOptions({
        temperature: 0.5,
        thinking: 'adaptive',
      }),
    ).toEqual({
      thinkingConfig: { type: 'adaptive' },
      temperatureOverride: undefined,
    })
  })
})
