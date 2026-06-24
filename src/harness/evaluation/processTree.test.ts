import { describe, expect, test } from 'bun:test'
import {
  collectDescendantPids,
  terminateProcessTree,
  terminateSpawnedProcessTree,
} from './processTree.js'

describe('evaluation process tree cleanup', () => {
  test('collects descendants recursively from a ps pid/ppid table', () => {
    const psOutput = [
      '   38    11',
      ' 7594    38',
      ' 7614  7594',
      ' 7615  7614',
      ' 8303    11',
      ' 8767  8303',
    ].join('\n')

    expect(collectDescendantPids(38, psOutput)).toEqual([7594, 7614, 7615])
  })

  test('terminates descendants before the root process on POSIX platforms', () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = []

    terminateProcessTree(38, 'SIGTERM', {
      platform: 'linux',
      readProcessTable: () => ['7594    38', '7614  7594', '7615  7614'].join('\n'),
      killPid: (pid, signal) => killed.push({ pid, signal }),
    })

    expect(killed).toEqual([
      { pid: 7615, signal: 'SIGTERM' },
      { pid: 7614, signal: 'SIGTERM' },
      { pid: 7594, signal: 'SIGTERM' },
      { pid: 38, signal: 'SIGTERM' },
    ])
  })

  test('also calls the child handle kill method after process-tree termination', () => {
    const killed: string[] = []
    const child = {
      pid: 38,
      kill(signal: NodeJS.Signals) {
        killed.push(`child:${signal}`)
      },
    }

    terminateSpawnedProcessTree(child, 'SIGKILL', {
      platform: 'linux',
      readProcessTable: () => '',
      killPid: (pid, signal) => killed.push(`${pid}:${signal}`),
    })

    expect(killed).toEqual(['38:SIGKILL', 'child:SIGKILL'])
  })
})
