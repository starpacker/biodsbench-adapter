import { existsSync } from 'fs'
import { cp, mkdir, readFile, symlink, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { TaskManifest, TaskRun } from './types.js'
import { isBioMniBenchTask, loadBioMniBenchManifest } from './biomnibenchAdapter.js'

export type CreateTaskRunInput = {
  taskId: string
  tasksDir?: string
  runsDir?: string
  timestamp?: string
}

function makeTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

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

function assertRelativeBundlePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe task bundle path: ${path}`)
  }
  return normalized
}

function resolveInside(base: string, relativePath: string): string {
  const target = resolve(base, relativePath)
  if (!isPathInside(target, base)) {
    throw new Error(`Unsafe task bundle path escapes root: ${relativePath}`)
  }
  return target
}

function isPrivatePath(path: string): boolean {
  const first = path.replace(/\\/g, '/').split('/')[0]
  return first === 'evaluation' || first === 'std_code'
}

async function readTaskManifest(taskDir: string): Promise<TaskManifest> {
  const raw = await readFile(join(taskDir, 'task_manifest.json'), 'utf8')
  return JSON.parse(stripUtf8Bom(raw)) as TaskManifest
}

async function loadTaskManifestForTask(taskDir: string, taskId: string): Promise<TaskManifest> {
  // BioMniBench tasks have a minimal on-disk manifest; synthesise/merge fields.
  if (isBioMniBenchTask(taskDir)) {
    return loadBioMniBenchManifest(taskDir, taskId)
  }
  return readTaskManifest(taskDir)
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function uniquePublicBundleEntries(manifest: TaskManifest): string[] {
  const entries = new Set<string>()
  for (const entry of manifest.public_bundle ?? []) {
    entries.add(assertRelativeBundlePath(entry))
  }

  // Some task manifests expose envs/runtime/ but put env_manifest.json in the
  // environment entrypoint. The manifest is public and is needed to resolve
  // cross-platform Python paths, so include it explicitly.
  if (manifest.entrypoints?.environment) {
    entries.add(assertRelativeBundlePath(manifest.entrypoints.environment))
  }

  return [...entries].filter(entry => !isPrivatePath(entry))
}

async function copyPublicEntry(taskDir: string, publicDir: string, entry: string): Promise<void> {
  const source = resolveInside(taskDir, entry)
  const destination = resolveInside(publicDir, entry)
  if (!existsSync(source)) return

  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: sourcePath => shouldCopyForCurrentHost(sourcePath),
  })
}

function isVirtualEnvPath(sourcePath: string): boolean {
  const segments = sourcePath.replace(/\\/g, '/').split('/')
  return segments.includes('.venv') || segments.includes('.venv-posix')
}

function shouldCopyForCurrentHost(sourcePath: string): boolean {
  return !isVirtualEnvPath(sourcePath)
}

async function linkDirectory(source: string, destination: string): Promise<void> {
  if (existsSync(destination)) return
  await mkdir(dirname(destination), { recursive: true })
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

async function linkHostRuntime(taskDir: string, publicDir: string): Promise<void> {
  const runtimeRoot = join('envs', 'runtime')
  const candidates =
    process.platform === 'win32' ? ['.venv'] : ['.venv-posix', '.venv']

  for (const candidate of candidates) {
    const source = resolveInside(taskDir, join(runtimeRoot, candidate))
    if (!existsSync(source)) continue
    const destination = resolveInside(publicDir, join(runtimeRoot, candidate))
    await linkDirectory(source, destination)
    return
  }
}

export async function createTaskRun(input: CreateTaskRunInput): Promise<TaskRun> {
  const tasksDir = resolve(input.tasksDir ?? 'tasks')
  const runsDir = resolve(input.runsDir ?? 'runs')
  const taskDir = resolveInside(tasksDir, input.taskId)
  const manifest = await loadTaskManifestForTask(taskDir, input.taskId)
  if (manifest.task_id !== input.taskId) {
    throw new Error(
      `Task manifest id mismatch: expected ${input.taskId}, got ${manifest.task_id}`,
    )
  }

  const timestamp = input.timestamp ?? makeTimestamp()
  const runId = `${input.taskId}_${timestamp}`
  const runDir = join(runsDir, runId)
  const judgeDir = join(runsDir, '.judge_private', runId)
  const publicDir = join(runDir, 'public')
  const workspaceDir = join(runDir, 'workspace')
  const outputsDir = join(runDir, manifest.submission?.output_dir ?? 'outputs')
  const logsDir = join(runDir, 'logs')

  await mkdir(publicDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(join(workspaceDir, 'plans'), { recursive: true })
  await mkdir(join(workspaceDir, 'experiments'), { recursive: true })
  await mkdir(outputsDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await mkdir(join(logsDir, 'agent'), { recursive: true })
  await mkdir(judgeDir, { recursive: true })

  for (const entry of uniquePublicBundleEntries(manifest)) {
    await copyPublicEntry(taskDir, publicDir, entry)
  }
  await linkHostRuntime(taskDir, publicDir)

  const runManifest = {
    version: 1,
    task_id: input.taskId,
    run_id: runId,
    source_task_dir: taskDir,
    public_dir: relative(runDir, publicDir),
    workspace_dir: basename(workspaceDir),
    outputs_dir: relative(runDir, outputsDir),
    logs_dir: basename(logsDir),
    created_at: new Date().toISOString(),
  }

  await writeFile(
    join(runDir, 'run_manifest.json'),
    `${JSON.stringify(runManifest, null, 2)}\n`,
    'utf8',
  )

  return {
    taskId: input.taskId,
    runId,
    runDir,
    judgeDir,
    publicDir,
    workspaceDir,
    outputsDir,
    logsDir,
    taskDir,
    manifest,
  }
}
