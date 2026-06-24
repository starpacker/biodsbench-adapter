import { existsSync } from 'fs'
import { cp, mkdir, readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { dirname, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import type {
  JudgeFeedbackLevel,
  JudgeResult,
  JudgeRunInput,
  TaskManifest,
  TaskRun,
} from './types.js'
import { resolveTaskRuntime } from './sourceRuntimeResolver.js'

const execFileAsync = promisify(execFile)

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

export async function resolveTaskPython(publicDir: string): Promise<string> {
  const runtime = await resolveTaskRuntime(publicDir)
  if (runtime.ok) return runtime.python
  throw new Error(runtime.error)
}

function publicPath(taskRun: TaskRun, manifestPath: string | undefined, fallback: string): string {
  return resolve(taskRun.publicDir, manifestPath ?? fallback)
}

function judgePath(taskRun: TaskRun, manifestPath: string | undefined, fallback: string): string {
  return resolve(taskRun.judgeDir, manifestPath ?? fallback)
}

async function copyPrivateJudgeBundle(taskRun: TaskRun): Promise<void> {
  const entries = taskRun.manifest.private_judge_bundle ?? ['evaluation/']
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`Unsafe private judge bundle path: ${entry}`)
    }
    // The judge executes with the public runtime Python, so copying envs into
    // .judge_private only adds slow, symlink-heavy venv duplication.
    if (normalized === 'envs' || normalized.startsWith('envs/')) {
      continue
    }
    const source = resolve(taskRun.taskDir, normalized)
    if (!existsSync(source)) continue
    const destination = resolve(taskRun.judgeDir, normalized)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      force: true,
      filter: sourcePath => shouldCopyForCurrentHost(sourcePath),
    })
  }
}

function shouldCopyForCurrentHost(sourcePath: string): boolean {
  const segments = sourcePath.replace(/\\/g, '/').split('/')
  if (segments.includes('reference_outputs') || segments.includes('__pycache__')) {
    return false
  }
  if (sourcePath.endsWith('.pyc')) {
    return false
  }
  if (process.platform === 'win32') {
    return !segments.includes('.venv-posix')
  }
  return !segments.includes('.venv')
}

function summarizeJudgeRaw(raw: unknown): string {
  if (raw && typeof raw === 'object') {
    const typed = raw as {
      status?: unknown
      summary?: unknown
      feedback?: unknown
      message?: unknown
      errors?: unknown
    }
    const parts = [typed.feedback, typed.summary, typed.message]
      .filter(value => typeof value === 'string' && value.length > 0)
      .map(String)
    if (parts.length > 0) return parts.join('\n')
    if (typed.errors) return JSON.stringify(typed.errors)
  }
  return JSON.stringify(raw)
}

function mapJudgeResult(raw: unknown, resultPath: string, stdout: string, stderr: string): JudgeResult {
  const rawStatus =
    raw && typeof raw === 'object' ? String((raw as { status?: unknown }).status ?? '') : ''
  const status = rawStatus === 'pass' ? 'pass' : rawStatus === 'fail' ? 'fail' : 'error'
  return {
    status,
    reward: status === 'pass' ? 1 : 0,
    feedback: summarizeJudgeRaw(raw),
    raw,
    resultPath,
    stdout,
    stderr,
  }
}

export function buildJudgeArgs(input: {
  taskRun: TaskRun
  round: number
  feedbackLevel?: JudgeFeedbackLevel
}): string[] {
  const { taskRun, round } = input
  const resultPath = join(taskRun.judgeDir, `judge_result_round_${round}.json`)
  return [
    judgePath(taskRun, taskRun.manifest.entrypoints?.judge, 'evaluation/judge.py'),
    '--submission',
    taskRun.outputsDir,
    '--cases',
    publicPath(taskRun, taskRun.manifest.entrypoints?.cases, 'visible_data/cases.json'),
    '--schema',
    publicPath(taskRun, taskRun.manifest.entrypoints?.output_schema, 'output_schema.json'),
    '--metrics',
    judgePath(taskRun, taskRun.manifest.entrypoints?.metrics, 'evaluation/metrics.json'),
    '--eval-data',
    judgePath(taskRun, undefined, 'evaluation/data'),
    '--result',
    resultPath,
    '--feedback-level',
    input.feedbackLevel ?? 'metric_status',
  ]
}

export class DefaultJudgeRunner {
  async run(input: JudgeRunInput): Promise<JudgeResult> {
    const { taskRun, round, timeoutSeconds } = input
    await copyPrivateJudgeBundle(taskRun)

    const python = input.runtime.python
    const resultPath = join(taskRun.judgeDir, `judge_result_round_${round}.json`)
    const logsDir = join(taskRun.judgeDir, 'logs')
    await mkdir(logsDir, { recursive: true })

    const args = buildJudgeArgs({
      taskRun,
      round,
      feedbackLevel: input.feedbackLevel,
    })

    let stdout = ''
    let stderr = ''
    try {
      const result = await execFileAsync(python, args, {
        cwd: taskRun.judgeDir,
        timeout: timeoutSeconds * 1000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      })
      stdout = result.stdout ?? ''
      stderr = result.stderr ?? ''
    } catch (error) {
      const typed = error as { stdout?: string; stderr?: string; message?: string }
      stdout = typed.stdout ?? ''
      stderr = typed.stderr ?? typed.message ?? ''
      await writeFile(join(logsDir, `round_${round}.stdout.log`), stdout, 'utf8')
      await writeFile(join(logsDir, `round_${round}.stderr.log`), stderr, 'utf8')
      if (existsSync(resultPath)) {
        const raw = JSON.parse(stripUtf8Bom(await readFile(resultPath, 'utf8')))
        return mapJudgeResult(raw, resultPath, stdout, stderr)
      }
      return {
        status: 'error',
        reward: 0,
        feedback: `Judge execution failed: ${stderr || stdout || 'unknown error'}`,
        raw: { error: stderr || stdout || 'unknown error' },
        resultPath,
        stdout,
        stderr,
      }
    }

    await writeFile(join(logsDir, `round_${round}.stdout.log`), stdout, 'utf8')
    await writeFile(join(logsDir, `round_${round}.stderr.log`), stderr, 'utf8')
    const raw = JSON.parse(stripUtf8Bom(await readFile(resultPath, 'utf8')))
    return mapJudgeResult(raw, resultPath, stdout, stderr)
  }
}

export type { TaskManifest }
