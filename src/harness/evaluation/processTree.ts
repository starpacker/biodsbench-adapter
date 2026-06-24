import { execFileSync } from 'node:child_process'

export type ProcessLike = {
  pid?: number
  kill(signal?: NodeJS.Signals): unknown
}

export type ProcessTreeOptions = {
  platform?: NodeJS.Platform | string
  readProcessTable?: () => string
  killPid?: (pid: number, signal: NodeJS.Signals) => void
}

export function collectDescendantPids(rootPid: number, psOutput: string): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const line of psOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const children = childrenByParent.get(ppid) ?? []
    children.push(pid)
    childrenByParent.set(ppid, children)
  }

  const descendants: number[] = []
  const queue = [...(childrenByParent.get(rootPid) ?? [])]
  for (const pid of queue) {
    descendants.push(pid)
    queue.push(...(childrenByParent.get(pid) ?? []))
  }
  return descendants
}

function readPosixProcessTable(): string {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 1000,
    })
  } catch {
    return ''
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Best effort: the process may have already exited.
  }
}

export function terminateProcessTree(
  rootPid: number,
  signal: NodeJS.Signals,
  options: ProcessTreeOptions = {},
): void {
  const platform = options.platform ?? process.platform
  const killPid = options.killPid ?? defaultKillPid
  if (platform === 'win32') {
    killPid(rootPid, signal)
    return
  }

  const readProcessTable = options.readProcessTable ?? readPosixProcessTable
  const descendants = collectDescendantPids(rootPid, readProcessTable())
  for (const descendantPid of descendants.reverse()) {
    killPid(descendantPid, signal)
  }
  killPid(rootPid, signal)
}

export function terminateSpawnedProcessTree(
  child: ProcessLike,
  signal: NodeJS.Signals,
  options: ProcessTreeOptions = {},
): void {
  const platform = options.platform ?? process.platform
  if (!child.pid || platform === 'win32') {
    child.kill(signal)
    return
  }

  terminateProcessTree(child.pid, signal, options)
  child.kill(signal)
}
