import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'

export type PublicSnapshotEntry = {
  entry_type: 'file' | 'dir'
  size: number
  mtimeMs: number
  content?: Buffer
}

export type PublicSnapshot = Map<string, PublicSnapshotEntry>

export type PublicSnapshotOptions = {
  includeFileContents?: boolean
  contentPathFilter?: (relativePath: string) => boolean
}

export type PublicMutation = {
  type: 'created' | 'modified' | 'deleted'
  path: string
  entry_type: 'file' | 'dir'
}

export type PublicRestoreResult = {
  removedCreatedPaths: string[]
  restoredPaths: string[]
  unrestoredPaths: string[]
}

function toPublicRelative(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, '/')
}

async function walkPublic(
  root: string,
  current: string,
  snapshot: PublicSnapshot,
  options: PublicSnapshotOptions,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    const linkMetadata = await lstat(fullPath)
    const isSymlink = linkMetadata.isSymbolicLink()
    let metadata = linkMetadata
    if (isSymlink) {
      try {
        metadata = await stat(fullPath)
      } catch {
        metadata = linkMetadata
      }
    }
    const isDirectory = metadata.isDirectory()
    const relativePath = toPublicRelative(root, fullPath)
    const snapshotEntry: PublicSnapshotEntry = {
      entry_type: isDirectory ? 'dir' : 'file',
      size: linkMetadata.size,
      mtimeMs: linkMetadata.mtimeMs,
    }
    if (
      !isDirectory &&
      !isSymlink &&
      options.includeFileContents &&
      (!options.contentPathFilter || options.contentPathFilter(relativePath))
    ) {
      snapshotEntry.content = await readFile(fullPath)
    }
    snapshot.set(relativePath, snapshotEntry)
    if (isDirectory && !isSymlink) {
      await walkPublic(root, fullPath, snapshot, options)
    }
  }
}

export async function takePublicSnapshot(
  publicDir: string,
  options: PublicSnapshotOptions = {},
): Promise<PublicSnapshot> {
  const snapshot: PublicSnapshot = new Map()
  await walkPublic(publicDir, publicDir, snapshot, options)
  return snapshot
}

export function diffPublicSnapshots(
  before: PublicSnapshot,
  after: PublicSnapshot,
  limit = 50,
): PublicMutation[] {
  const mutations: PublicMutation[] = []

  for (const [path, afterEntry] of after.entries()) {
    const beforeEntry = before.get(path)
    if (!beforeEntry) {
      mutations.push({
        type: 'created',
        path,
        entry_type: afterEntry.entry_type,
      })
    } else if (
      beforeEntry.entry_type !== afterEntry.entry_type ||
      beforeEntry.size !== afterEntry.size ||
      beforeEntry.mtimeMs !== afterEntry.mtimeMs ||
      (beforeEntry.content !== undefined &&
        afterEntry.content !== undefined &&
        !beforeEntry.content.equals(afterEntry.content))
    ) {
      mutations.push({
        type: 'modified',
        path,
        entry_type: afterEntry.entry_type,
      })
    }
    if (mutations.length >= limit) return mutations
  }

  for (const [path, beforeEntry] of before.entries()) {
    if (!after.has(path)) {
      mutations.push({
        type: 'deleted',
        path,
        entry_type: beforeEntry.entry_type,
      })
    }
    if (mutations.length >= limit) return mutations
  }

  return mutations
}

function isInside(path: string, parent: string): boolean {
  const resolvedChild = resolve(path)
  const resolvedBase = resolve(parent)
  const child = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild
  const base = process.platform === 'win32' ? resolvedBase.toLowerCase() : resolvedBase
  return child === base || child.startsWith(`${base}\\`) || child.startsWith(`${base}/`)
}

export async function cleanupCreatedPublicEntries(
  publicDir: string,
  mutations: PublicMutation[],
): Promise<string[]> {
  const created = mutations
    .filter(mutation => mutation.type === 'created')
    .map(mutation => mutation.path)
    .sort((a, b) => b.length - a.length)
  const removed: string[] = []

  for (const relativePath of created) {
    const target = resolve(publicDir, relativePath)
    if (!isInside(target, publicDir) || target === resolve(publicDir)) continue
    await rm(target, { recursive: true, force: true })
    removed.push(relativePath)
  }

  return removed
}

export async function restorePublicSnapshotMutations(
  publicDir: string,
  before: PublicSnapshot,
  mutations: PublicMutation[],
): Promise<PublicRestoreResult> {
  const result: PublicRestoreResult = {
    removedCreatedPaths: [],
    restoredPaths: [],
    unrestoredPaths: [],
  }

  result.removedCreatedPaths = await cleanupCreatedPublicEntries(publicDir, mutations)

  const deletedDirs = mutations
    .filter(mutation => mutation.type === 'deleted')
    .filter(mutation => before.get(mutation.path)?.entry_type === 'dir')
    .map(mutation => mutation.path)
    .sort((a, b) => a.length - b.length)

  for (const relativePath of deletedDirs) {
    const target = resolve(publicDir, relativePath)
    if (!isInside(target, publicDir) || target === resolve(publicDir)) continue
    await mkdir(target, { recursive: true })
    result.restoredPaths.push(relativePath)
  }

  const filesToRestore = mutations
    .filter(mutation => mutation.type === 'modified' || mutation.type === 'deleted')
    .filter(mutation => before.get(mutation.path)?.entry_type === 'file')
    .map(mutation => mutation.path)
    .sort((a, b) => a.length - b.length)

  for (const relativePath of filesToRestore) {
    const beforeEntry = before.get(relativePath)
    const target = resolve(publicDir, relativePath)
    if (!beforeEntry?.content || !isInside(target, publicDir)) {
      result.unrestoredPaths.push(relativePath)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, beforeEntry.content)
    result.restoredPaths.push(relativePath)
  }

  return result
}
