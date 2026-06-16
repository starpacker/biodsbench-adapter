import { describe, expect, test } from 'bun:test'
import { sourceEventsFromSdkMessage } from './sdkMessageAdapter.js'

describe('sourceEventsFromSdkMessage', () => {
  test('converts QueryEngine result messages to trajectory events', () => {
    const events = sourceEventsFromSdkMessage({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      duration_ms: 1234,
      duration_api_ms: 1000,
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 5 },
      errors: [],
    })

    expect(events).toEqual([
      {
        type: 'agent_result',
        subtype: 'success',
        stopReason: 'end_turn',
        durationMs: 1234,
        durationApiMs: 1000,
        isError: false,
        usage: { input_tokens: 10, output_tokens: 5 },
        errors: [],
        raw: expect.any(Object),
      },
    ])
  })
})
