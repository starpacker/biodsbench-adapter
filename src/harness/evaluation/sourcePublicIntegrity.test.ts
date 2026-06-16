import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import {
  diffPublicSnapshots,
  restorePublicSnapshotMutations,
  takePublicSnapshot,
} from './sourcePublicIntegrity.js'

describe('source public integrity guard', () => {
  test('snapshots symlinked runtime directories without reading them as files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'source-public-symlink-'))
    const publicDir = join(tempDir, 'public')
    const runtimeDir = join(tempDir, 'runtime')
    await mkdir(join(publicDir, 'envs'), { recursive: true })
    await mkdir(runtimeDir, { recursive: true })
    await writeFile(join(runtimeDir, 'python'), 'runtime binary placeholder')
    await symlink(
      runtimeDir,
      join(publicDir, 'envs', 'runtime'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const snapshot = await takePublicSnapshot(publicDir, {
      includeFileContents: true,
    })

    expect(snapshot.get('envs/runtime')?.entry_type).toBe('dir')
    expect(snapshot.has('envs/runtime/python')).toBe(false)
  })

  test('detects created and modified files under public', async () => {
    const publicDir = await mkdtemp(join(tmpdir(), 'source-public-'))
    await mkdir(join(publicDir, 'visible_data', 'cases', 'case_000', 'input_data'), {
      recursive: true,
    })
    const rawPath = join(
      publicDir,
      'visible_data',
      'cases',
      'case_000',
      'input_data',
      'raw_data.npz',
    )
    const metaPath = join(
      publicDir,
      'visible_data',
      'cases',
      'case_000',
      'input_data',
      'meta.txt',
    )
    await writeFile(rawPath, 'before')
    await writeFile(metaPath, 'metadata')
    const before = await takePublicSnapshot(publicDir, { includeFileContents: true })

    await mkdir(join(publicDir, 'visible_data', 'cases', 'case_000', 'input_data', 'workspace'), {
      recursive: true,
    })
    await writeFile(rawPath, 'after')
    await unlink(metaPath)
    const after = await takePublicSnapshot(publicDir, { includeFileContents: true })

    const mutations = diffPublicSnapshots(before, after)

    expect(mutations).toContainEqual({
      type: 'created',
      path: 'visible_data/cases/case_000/input_data/workspace',
      entry_type: 'dir',
    })
    expect(mutations).toContainEqual({
      type: 'modified',
      path: 'visible_data/cases/case_000/input_data/raw_data.npz',
      entry_type: 'file',
    })
    expect(mutations).toContainEqual({
      type: 'deleted',
      path: 'visible_data/cases/case_000/input_data/meta.txt',
      entry_type: 'file',
    })

    const restoreResult = await restorePublicSnapshotMutations(publicDir, before, mutations)
    expect(restoreResult.removedCreatedPaths).toContain(
      'visible_data/cases/case_000/input_data/workspace',
    )
    expect(
      existsSync(join(publicDir, 'visible_data', 'cases', 'case_000', 'input_data', 'workspace')),
    ).toBe(false)
    expect(restoreResult.restoredPaths).toContain(
      'visible_data/cases/case_000/input_data/raw_data.npz',
    )
    expect(restoreResult.restoredPaths).toContain(
      'visible_data/cases/case_000/input_data/meta.txt',
    )
    expect(await readFile(rawPath, 'utf8')).toBe('before')
    expect(await readFile(metaPath, 'utf8')).toBe('metadata')
  })
})
