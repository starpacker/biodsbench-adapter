import { describe, expect, test } from 'bun:test'
import {
  drainFinalizeStateEvents,
  selectSourceToolPool,
} from './sourceClaudeSessionAgent.js'
import type { FinalizeSubmissionState } from './finalizeSubmissionTool.js'

function tool(name: string) {
  return { name } as never
}

describe('selectSourceToolPool', () => {
  test('keeps the standard eval tools and removes TodoWrite noise', () => {
    const selected = selectSourceToolPool(
      [
        tool('Read'),
        tool('Write'),
        tool('Edit'),
        tool('MultiEdit'),
        tool('Glob'),
        tool('Grep'),
        tool('Bash'),
        tool('TodoWrite'),
        tool('Agent'),
      ],
      tool('finalize_submission'),
    )

    expect(selected.map(item => item.name)).toEqual([
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Glob',
      'Grep',
      'Bash',
      'finalize_submission',
    ])
  })
})

describe('drainFinalizeStateEvents', () => {
  test('emits a terminal finalize event as soon as validation has passed', () => {
    const state: FinalizeSubmissionState = {
      readyForJudge: true,
      summary: 'ready',
      files: ['outputs/case_000.npz'],
      pendingEvents: [
        {
          type: 'submission_validation_passed',
          result: {
            ok: true,
            normalizedFiles: ['outputs/case_000.npz'],
            issues: [],
          },
        },
      ],
    }

    const drained = drainFinalizeStateEvents(state)

    expect(drained.readyForJudge).toBe(true)
    expect(drained.events.map(event => event.type)).toEqual([
      'submission_validation_passed',
      'finalize',
    ])
    expect(drained.events.at(-1)).toEqual({
      type: 'finalize',
      summary: 'ready',
      files: ['outputs/case_000.npz'],
    })
    expect(state.pendingEvents).toEqual([])
  })

  test('does not emit finalize for recoverable validation feedback', () => {
    const state: FinalizeSubmissionState = {
      readyForJudge: false,
      summary: '',
      files: [],
      pendingEvents: [
        {
          type: 'submission_validation_failed',
          result: {
            ok: false,
            normalizedFiles: [],
            issues: [
              {
                code: 'missing_output_file',
                path: 'outputs/case_000.npz',
                message: 'outputs/case_000.npz is missing',
              },
            ],
          },
        },
      ],
    }

    const drained = drainFinalizeStateEvents(state)

    expect(drained.readyForJudge).toBe(false)
    expect(drained.events.map(event => event.type)).toEqual([
      'submission_validation_failed',
    ])
    expect(state.pendingEvents).toEqual([])
  })
})
