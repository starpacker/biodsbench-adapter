import { existsSync } from 'fs'
import { cp, mkdir, readFile, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { dirname, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import type { JudgeResult, JudgeRunInput, TaskManifest, TaskRun } from './types.js'
import { resolveTaskRuntime } from './sourceRuntimeResolver.js'
import { isBioMniBenchTask, QWEN_JUDGE_SCRIPT } from './biomnibenchAdapter.js'

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

/**
 * Map a BioMniBench qwen-judge JSON result into the harness JudgeResult shape.
 * The qwen judge emits `{ score: 0..100, criteria: {...}, reasoning: "..." }`.
 * We treat score >= passThreshold as `pass`, anything strictly less as `fail`.
 */
function mapBioMniBenchJudgeResult(
  raw: unknown,
  resultPath: string,
  stdout: string,
  stderr: string,
  passThreshold = 60,
): JudgeResult {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) ?? {}
  const rawScore = typeof obj.score === 'number' ? obj.score : Number(obj.score ?? 0)
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, rawScore)) : 0
  const status: JudgeResult['status'] = obj.error
    ? 'error'
    : score >= passThreshold
      ? 'pass'
      : 'fail'

  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : ''
  const errorText = typeof obj.error === 'string' ? obj.error : ''
  const feedback = [
    `Score: ${score}/100`,
    reasoning ? `Reasoning: ${reasoning}` : '',
    errorText ? `Error: ${errorText}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    status,
    reward: score / 100,
    feedback: feedback || `Score: ${score}/100`,
    raw,
    resultPath,
    stdout,
    stderr,
  }
}

export class DefaultJudgeRunner {
  async run(input: JudgeRunInput): Promise<JudgeResult> {
    const { taskRun, round, timeoutSeconds } = input
    await copyPrivateJudgeBundle(taskRun)

    // BioMniBench dispatch: tasks with rubric.txt use llm_judge_qwen.py instead
    // of the imaging-style judge.py (which expects --cases / --schema / arrays).
    if (isBioMniBenchTask(taskRun.taskDir)) {
      return this.runBioMniBenchJudge(input)
    }

    const python = input.runtime.python
    const resultPath = join(taskRun.judgeDir, `judge_result_round_${round}.json`)
    const logsDir = join(taskRun.judgeDir, 'logs')
    await mkdir(logsDir, { recursive: true })

    const args = [
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
      'metric_status',
    ]

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

  /**
   * Run the BioMniBench qwen-backed LLM judge:
   *   - Reads outputs/trace.md and outputs/answer.txt from the run.
   *   - Reads evaluation/rubric.txt from the private judge bundle.
   *   - Invokes llm_judge_qwen.py with: <trace> <answer> <rubric> <result>.
   *   - The script writes a JSON result file with { score, criteria, reasoning }.
   */
  private async runBioMniBenchJudge(input: JudgeRunInput): Promise<JudgeResult> {
    const { taskRun, round, timeoutSeconds } = input
    const python = input.runtime.python
    const resultPath = join(taskRun.judgeDir, `judge_result_round_${round}.json`)
    const logsDir = join(taskRun.judgeDir, 'logs')
    await mkdir(logsDir, { recursive: true })

    const tracePath = join(taskRun.outputsDir, 'trace.md')
    const answerPath = join(taskRun.outputsDir, 'answer.txt')
    const rubricPath = join(taskRun.judgeDir, 'evaluation', 'rubric.txt')

    if (!existsSync(rubricPath)) {
      return {
        status: 'error',
        reward: 0,
        feedback: `BioMniBench judge: rubric.txt not found at ${rubricPath}`,
        raw: { error: 'rubric_missing', resultPath },
        resultPath,
        stdout: '',
        stderr: '',
      }
    }
    if (!existsSync(QWEN_JUDGE_SCRIPT)) {
      return {
        status: 'error',
        reward: 0,
        feedback: `BioMniBench judge: llm_judge_qwen.py not found at ${QWEN_JUDGE_SCRIPT}`,
        raw: { error: 'judge_script_missing', resultPath },
        resultPath,
        stdout: '',
        stderr: '',
      }
    }
    // If neither output file exists, short-circuit with score 0 and a useful
    // feedback string so the agent has something concrete to react to.
    if (!existsSync(tracePath) && !existsSync(answerPath)) {
      const raw = {
        score: 0,
        error: 'No output files found: trace.md and answer.txt are both missing.',
      }
      await writeFile(resultPath, JSON.stringify(raw, null, 2), 'utf8')
      return mapBioMniBenchJudgeResult(raw, resultPath, '', '')
    }

    const args = [QWEN_JUDGE_SCRIPT, tracePath, answerPath, rubricPath, resultPath]
    let stdout = ''
    let stderr = ''

    try {
      const result = await execFileAsync(python, args, {
        cwd: taskRun.judgeDir,
        timeout: timeoutSeconds * 1000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          // Make sure the qwen judge inherits the harness env vars even if
          // execFile is given a sanitized PATH.
          QWEN_API_KEY: process.env.QWEN_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '',
          QWEN_BASE_URL:
            process.env.QWEN_BASE_URL ?? 'https://api.gpugeek.com/v1',
          QWEN_MODEL: process.env.QWEN_MODEL ?? 'Vendor3/qwen3.5-plus',
        },
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
        return mapBioMniBenchJudgeResult(raw, resultPath, stdout, stderr)
      }
      return {
        status: 'error',
        reward: 0,
        feedback: `BioMniBench judge execution failed: ${stderr || stdout || 'unknown error'}`,
        raw: { error: stderr || stdout || 'unknown error' },
        resultPath,
        stdout,
        stderr,
      }
    }

    await writeFile(join(logsDir, `round_${round}.stdout.log`), stdout, 'utf8')
    await writeFile(join(logsDir, `round_${round}.stderr.log`), stderr, 'utf8')

    if (!existsSync(resultPath)) {
      return {
        status: 'error',
        reward: 0,
        feedback: `BioMniBench judge produced no result file (${resultPath}). stdout=${stdout.slice(0, 500)}`,
        raw: { error: 'no_result_file', stdout, stderr },
        resultPath,
        stdout,
        stderr,
      }
    }

    const raw = JSON.parse(stripUtf8Bom(await readFile(resultPath, 'utf8')))
    return mapBioMniBenchJudgeResult(raw, resultPath, stdout, stderr)
  }
}

export type { TaskManifest }
