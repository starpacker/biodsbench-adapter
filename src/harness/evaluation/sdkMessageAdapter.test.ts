import { describe, expect, test } from 'bun:test'
import { sourceEventsFromSdkMessage } from './sdkMessageAdapter.js'

describe('sourceEventsFromSdkMessage', () => {
  test('emits assistant_thinking events for thinking content blocks', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking: 'Let me figure out the answer.',
            signature: 'sig-abc',
          },
        ],
      },
    }
    const events = sourceEventsFromSdkMessage(message)
    expect(events).toEqual([
      {
        type: 'assistant_thinking',
        text: 'Let me figure out the answer.',
        signature: 'sig-abc',
        raw: message,
      },
    ])
  })

  test('keeps thinking + text + tool_use blocks in order on a single assistant message', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'planning' },
          { type: 'text', text: 'doing the work' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }
    const events = sourceEventsFromSdkMessage(message)
    expect(events.map((e) => e.type)).toEqual([
      'assistant_thinking',
      'assistant_text',
      'tool_call',
    ])
  })

  test('skips whitespace-only thinking blocks', () => {
    const events = sourceEventsFromSdkMessage({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '   ' }] },
    })
    expect(events).toEqual([])
  })

  test('converts compact boundary system messages into context events', () => {
    const events = sourceEventsFromSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      message: 'compacted conversation',
      usage: { input_tokens: 1000 },
    })

    expect(events).toEqual([
      expect.objectContaining({
        type: 'context_event',
        subtype: 'compact_boundary',
        message: 'compacted conversation',
        usage: { input_tokens: 1000 },
      }),
    ])
  })

  test('adds context event for model context window exhaustion', () => {
    const events = sourceEventsFromSdkMessage({
      type: 'result',
      subtype: 'error',
      stop_reason: 'model_context_window_exceeded',
      is_error: true,
      usage: { input_tokens: 200000 },
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'context_event',
        subtype: 'model_context_window_exceeded',
        usage: { input_tokens: 200000 },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent_result',
        stopReason: 'model_context_window_exceeded',
      }),
    )
  })

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
