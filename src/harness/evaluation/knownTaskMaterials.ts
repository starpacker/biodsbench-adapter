import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { KnownTaskMaterialsAudit, KnownTaskMaterialsOptions } from './types.js'

function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child)
  const normalizedParent = resolve(parent)
  const comparisonChild =
    process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild
  const comparisonParent =
    process.platform === 'win32' ? normalizedParent.toLowerCase() : normalizedParent
  return (
    comparisonChild === comparisonParent ||
    comparisonChild.startsWith(`${comparisonParent}\\`) ||
    comparisonChild.startsWith(`${comparisonParent}/`)
  )
}

function assertSafeTaskIdSegment(taskId: string): void {
  if (
    !taskId ||
    isAbsolute(taskId) ||
    taskId.includes('/') ||
    taskId.includes('\\') ||
    taskId.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`Unsafe known task id: ${taskId}`)
  }
}

function normalizeTaskId(taskId: string): string {
  return taskId.toLowerCase()
}

function assertNotTargetTask(targetTaskId: string, sourceTaskId: string): void {
  if (normalizeTaskId(sourceTaskId) === normalizeTaskId(targetTaskId)) {
    throw new Error('target task cannot be used as known task material')
  }
}

function normalizeResolvedPath(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function resolveInside(base: string, relativePath: string): string {
  const target = resolve(base, relativePath)
  if (!isPathInside(target, base)) {
    throw new Error(`Unsafe known task material path escapes root: ${relativePath}`)
  }
  return target
}

function isIgnoredMaterialPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/')
  const basename = parts.at(-1) ?? ''
  return (
    parts.includes('__pycache__') ||
    basename.startsWith('.') ||
    basename.endsWith('.pyc') ||
    basename.endsWith('.pyo') ||
    basename.endsWith('~') ||
    basename === 'Thumbs.db'
  )
}

export function selectKnownTaskMaterialFiles(files: string[]): string[] {
  return files
    .map(path => path.replace(/\\/g, '/'))
    .filter(path => !isAbsolute(path) && !path.split('/').includes('..'))
    .filter(
      path =>
        path === 'README.md' ||
        path === 'std_code/main.py' ||
        path.startsWith('std_code/src/'),
    )
    .filter(path => !isIgnoredMaterialPath(path))
    .sort((a, b) => a.localeCompare(b))
}

export function assertKnownTaskMaterialRequestSafe(input: {
  targetTaskId: string
  sourceTaskIds: string[]
}): void {
  assertSafeTaskIdSegment(input.targetTaskId)
  if (input.sourceTaskIds.length === 0) {
    throw new Error('at least one known task source is required')
  }
  for (const sourceTaskId of input.sourceTaskIds) {
    assertSafeTaskIdSegment(sourceTaskId)
    assertNotTargetTask(input.targetTaskId, sourceTaskId)
  }
}

async function readManifestTaskId(taskDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(taskDir, 'task_manifest.json'), 'utf8')
    const manifest = JSON.parse(stripUtf8Bom(raw)) as { task_id?: unknown }
    return typeof manifest.task_id === 'string' ? manifest.task_id : undefined
  } catch {
    return undefined
  }
}

async function collectSourceFiles(root: string, currentDir = root): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name)
    const relativePath = relative(root, absolutePath).replace(/\\/g, '/')
    const stat = await lstat(absolutePath)
    if (stat.isSymbolicLink()) continue
    if (isIgnoredMaterialPath(relativePath)) continue
    if (stat.isDirectory()) {
      files.push(...(await collectSourceFiles(root, absolutePath)))
      continue
    }
    if (stat.isFile()) files.push(relativePath)
  }
  return files
}

async function collectCandidateMaterialFiles(sourceTaskDir: string): Promise<string[]> {
  const sourceStat = await lstat(sourceTaskDir)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Known task source is not a directory: ${sourceTaskDir}`)
  }

  const files: string[] = []
  try {
    const readme = join(sourceTaskDir, 'README.md')
    const readmeStat = await lstat(readme)
    if (readmeStat.isFile() && !readmeStat.isSymbolicLink()) {
      files.push('README.md')
    }
  } catch {
    // README.md is optional for audit purposes; std_code may still be copied.
  }

  try {
    const stdCodeDir = join(sourceTaskDir, 'std_code')
    const stdCodeStat = await lstat(stdCodeDir)
    if (stdCodeStat.isDirectory() && !stdCodeStat.isSymbolicLink()) {
      files.push(...(await collectSourceFiles(sourceTaskDir, stdCodeDir)))
    }
  } catch {
    // Missing std_code/ leaves only README.md, if present.
  }

  return files
}

export async function copyKnownTaskMaterials(input: {
  targetTaskId: string
  tasksDir: string
  publicDir: string
  options: KnownTaskMaterialsOptions
}): Promise<KnownTaskMaterialsAudit> {
  if (!input.options.enabled) {
    return { enabled: false, copied: [], skipped: [] }
  }

  assertKnownTaskMaterialRequestSafe({
    targetTaskId: input.targetTaskId,
    sourceTaskIds: input.options.sourceTaskIds,
  })

  const tasksDir = resolve(input.tasksDir)
  const publicDir = resolve(input.publicDir)
  const targetTaskDir = resolveInside(tasksDir, input.targetTaskId)
  const targetRealPath = normalizeResolvedPath(await realpath(targetTaskDir))
  const copied: KnownTaskMaterialsAudit['copied'] = []

  for (const sourceTaskId of input.options.sourceTaskIds) {
    const sourceTaskDir = resolveInside(tasksDir, sourceTaskId)
    const sourceRealPath = normalizeResolvedPath(await realpath(sourceTaskDir))
    const sourceManifestTaskId = await readManifestTaskId(sourceTaskDir)
    if (
      sourceRealPath === targetRealPath ||
      (sourceManifestTaskId &&
        normalizeTaskId(sourceManifestTaskId) === normalizeTaskId(input.targetTaskId))
    ) {
      throw new Error('target task cannot be used as known task material')
    }
    const allFiles = await collectCandidateMaterialFiles(sourceTaskDir)
    const selectedFiles = selectKnownTaskMaterialFiles(allFiles)
    if (selectedFiles.length === 0) {
      throw new Error(`Known task source ${sourceTaskId} has no README.md or std_code files`)
    }
    const destinationRoot = resolveInside(
      publicDir,
      join('known_tasks', sourceTaskId),
    )

    for (const file of selectedFiles) {
      const sourcePath = resolveInside(sourceTaskDir, file)
      const destinationPath = resolveInside(destinationRoot, file)
      await mkdir(dirname(destinationPath), { recursive: true })
      await copyFile(sourcePath, destinationPath)
    }

    copied.push({ sourceTaskId, files: selectedFiles })
  }

  return { enabled: true, copied, skipped: [] }
}
