import type { SourceAgentEvent } from './types.js'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function textFromBlock(block: Record<string, unknown>): string | undefined {
  return typeof block.text === 'string' ? block.text : undefined
}

function idFromBlock(block: Record<string, unknown>): string | undefined {
  const id = block.id ?? block.tool_use_id
  return typeof id === 'string' ? id : undefined
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function nullableStringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function errorsFromRecord(record: Record<string, unknown>): string[] | undefined {
  const value = record.errors
  return Array.isArray(value) ? value.map(String) : undefined
}

export function sourceEventsFromSdkMessage(message: unknown): SourceAgentEvent[] {
  const record = asRecord(message)
  const type = record.type
  const nested = asRecord(record.message)
  const content = Array.isArray(nested.content) ? nested.content : []
  const events: SourceAgentEvent[] = []

  if (type === 'assistant') {
    for (const rawBlock of content) {
      const block = asRecord(rawBlock)
      if (block.type === 'text') {
        const text = textFromBlock(block)
        if (text?.trim()) events.push({ type: 'assistant_text', text, raw: message })
      }
      if (block.type === 'tool_use') {
        events.push({
          type: 'tool_call',
          tool: String(block.name ?? 'unknown'),
          toolUseId: idFromBlock(block),
          input: block.input,
          raw: message,
        })
      }
    }
  }

  if (type === 'user') {
    const userContent = Array.isArray(nested.content) ? nested.content : record.message
    if (Array.isArray(userContent)) {
      for (const rawBlock of userContent) {
        const block = asRecord(rawBlock)
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? '')
          events.push({
            type: 'tool_result',
            toolUseId: idFromBlock(block),
            ok: !Boolean(block.is_error),
            text,
            raw: message,
          })
        }
      }
    }
  }

  if (type === 'result') {
    events.push({
      type: 'agent_result',
      subtype: stringFromRecord(record, 'subtype'),
      stopReason: nullableStringFromRecord(record, 'stop_reason'),
      durationMs: numberFromRecord(record, 'duration_ms'),
      durationApiMs: numberFromRecord(record, 'duration_api_ms'),
      isError: Boolean(record.is_error),
      usage: record.usage,
      errors: errorsFromRecord(record),
      raw: message,
    })
  }

  return events
}
