import { describe, expect, test } from 'bun:test'
import { exitCodeForLoopStatus, parseEvaluationCliArgs } from './cli.js'

describe('parseEvaluationCliArgs', () => {
  test('requires task id and parses loop controls', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--max-rounds',
      '4',
      '--timeout-seconds',
      '120',
      '--concurrency',
      '3',
      '--worker-timeout-grace-seconds',
      '15',
      '--max-turns-per-round',
      '9',
      '--agent-runtime',
      'source',
      '--runs-dir',
      'output/runs',
    ])

    expect(parsed.taskId).toBe('demo_task')
    expect(parsed.maxRounds).toBe(4)
    expect(parsed.maxTurnsPerRound).toBe(9)
    expect(parsed.timeoutSeconds).toBe(120)
    expect(parsed.concurrency).toBe(3)
    expect(parsed.workerTimeoutGraceSeconds).toBe(15)
    expect(parsed.runsDir).toBe('output/runs')
    expect(parsed.agentRuntime).toBe('source')
    expect(parsed.temperature).toBe(1)
    expect(parsed.thinking).toBe('disabled')
    expect(parsed.taskIds).toEqual(['demo_task'])
    expect(parsed.systemPromptPath).toBeUndefined()
  })

  test('parses repeated tasks for source batch mode', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'task_a,task_b',
      '--task',
      'task_c',
      '--quiet',
    ])

    expect(parsed.taskId).toBe('task_a')
    expect(parsed.taskIds).toEqual(['task_a', 'task_b', 'task_c'])
    expect(parsed.maxTurnsPerRound).toBeUndefined()
    expect(parsed.verbose).toBe(false)
  })

  test('rejects removed legacy subprocess runtime', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--agent-runtime', 'legacy-subprocess']),
    ).toThrow('legacy-subprocess has been removed')
  })

  test('parses temperature and thinking controls', () => {
    const parsed = parseEvaluationCliArgs([
      '--task',
      'demo_task',
      '--temperature',
      '0.2',
      '--thinking',
      'adaptive',
    ])

    expect(parsed.temperature).toBe(0.2)
    expect(parsed.thinking).toBe('adaptive')
  })

  test('rejects invalid temperature and thinking values', () => {
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--temperature', 'hot']),
    ).toThrow('--temperature')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--temperature', '2']),
    ).toThrow('--temperature')
    expect(() =>
      parseEvaluationCliArgs(['--task', 'demo_task', '--thinking', 'enabled']),
    ).toThrow('--thinking')
  })

  test('maps loop status to process exit code', () => {
    expect(exitCodeForLoopStatus('success')).toBe(0)
    expect(exitCodeForLoopStatus('failed')).toBe(1)
    expect(exitCodeForLoopStatus('timeout')).toBe(1)
    expect(exitCodeForLoopStatus('infra_error')).toBe(1)
  })
})
