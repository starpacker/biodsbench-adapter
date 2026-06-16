import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import type {
  RuntimeInfo,
  SubmissionValidationIssue,
  SubmissionValidationResult,
  TaskRun,
} from './types.js'

type OutputSchema = {
  format?: string
  path_template?: string
  submission?: {
    path_template?: string
  }
  arrays?: Array<{
    key?: string
    required?: boolean
    shape?: unknown
    dtype?: unknown
  }>
  validation?: {
    finite_only?: boolean
    allow_cast?: boolean
  }
}

type CasesConfig =
  | Array<{ id?: string; expected_output?: string }>
  | {
      cases?: Array<{ id?: string; expected_output?: string }>
    }

export type ValidateSubmissionInput = {
  taskRun: TaskRun
  runtime?: RuntimeInfo
  files: string[]
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function isInside(path: string, parent: string): boolean {
  const child = resolve(path)
  const base = resolve(parent)
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base
  return (
    normalizedChild === normalizedBase ||
    normalizedChild.startsWith(`${normalizedBase}\\`) ||
    normalizedChild.startsWith(`${normalizedBase}/`)
  )
}

async function readJsonIfExists<T>(
  path: string,
): Promise<{ ok: true; value?: T } | { ok: false; error: string }> {
  if (!existsSync(path)) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(stripUtf8Bom(await readFile(path, 'utf8'))) as T }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function schemaPath(taskRun: TaskRun): string {
  return join(taskRun.publicDir, taskRun.manifest.entrypoints?.output_schema ?? 'output_schema.json')
}

function casesPath(taskRun: TaskRun): string {
  return join(taskRun.publicDir, taskRun.manifest.entrypoints?.cases ?? join('visible_data', 'cases.json'))
}

function normalizeOutputPath(
  taskRun: TaskRun,
  path: string,
): { rel?: string; absolute?: string; issue?: SubmissionValidationIssue } {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(taskRun.runDir, path)
  if (!isInside(absolute, taskRun.outputsDir)) {
    return {
      issue: {
        code: 'path_outside_outputs',
        path,
        message: `submission file must be under outputs/: ${path}`,
      },
    }
  }
  const rel = `outputs/${relative(taskRun.outputsDir, absolute).replace(/\\/g, '/')}`
  return { rel, absolute }
}

function normalizeDtypeList(dtype: unknown): string[] {
  if (Array.isArray(dtype)) return dtype.map(String)
  if (typeof dtype === 'string') return [dtype]
  return []
}

function normalizeShape(shape: unknown): number[] | undefined {
  if (!Array.isArray(shape)) return undefined
  const values = shape.map(Number)
  return values.every(Number.isInteger) ? values : undefined
}

function requiredArrays(schema: OutputSchema | undefined) {
  return (schema?.arrays ?? [])
    .filter(array => array.required !== false && typeof array.key === 'string')
    .map(array => ({
      key: String(array.key),
      shape: normalizeShape(array.shape),
      dtype: normalizeDtypeList(array.dtype),
    }))
}

function casesFromConfig(cases: CasesConfig | undefined): Array<{
  id?: string
  expected_output?: string
}> {
  if (!cases) return []
  if (Array.isArray(cases)) return cases
  return cases.cases ?? []
}

function expectedFilesFromContract(
  schema: OutputSchema | undefined,
  cases: CasesConfig | undefined,
): string[] {
  const pattern =
    schema?.submission?.path_template ??
    schema?.path_template ??
    'outputs/{case_id}.npz'
  return casesFromConfig(cases)
    .map((item, index) => {
      if (typeof item.expected_output === 'string') return item.expected_output
      const caseId = item.id ?? `case_${String(index).padStart(3, '0')}`
      return pattern.replaceAll('{case_id}', caseId)
    })
    .filter(Boolean)
}

function issueText(issue: SubmissionValidationIssue): string {
  const parts = [issue.path, issue.key].filter(Boolean).join(' ')
  return parts ? `${parts}: ${issue.message}` : issue.message
}

export function formatSubmissionValidationFeedback(
  result: SubmissionValidationResult,
): string {
  return [
    'finalize_submission validation failed:',
    ...result.issues.map(issue => `- ${issueText(issue)}`),
    '',
    'Fix the outputs and call finalize_submission again.',
  ].join('\n')
}

async function validateNpzWithPython(input: {
  python: string
  files: Array<{ rel: string; absolute: string }>
  arrays: Array<{ key: string; shape?: number[]; dtype: string[] }>
  finiteOnly: boolean
  allowCast: boolean
}): Promise<SubmissionValidationIssue[]> {
  const script = String.raw`
import json
import sys

payload = json.loads(sys.argv[1])
issues = []

try:
    import numpy as np
except Exception as exc:
    print(json.dumps({"runtime_error": "failed to import numpy: " + str(exc)}))
    sys.exit(0)

def add(code, path, message, key=None, details=None):
    issue = {"code": code, "path": path, "message": message}
    if key is not None:
        issue["key"] = key
    if details is not None:
        issue["details"] = details
    issues.append(issue)

for file_info in payload["files"]:
    rel = file_info["rel"]
    try:
        data = np.load(file_info["absolute"], allow_pickle=False)
    except Exception as exc:
        add("npz_read_failed", rel, "failed to read npz: " + str(exc))
        continue
    try:
        keys = set(data.files)
        for array_spec in payload["arrays"]:
            key = array_spec["key"]
            if key not in keys:
                add("missing_array_key", rel, "missing required key " + key, key)
                continue
            array = data[key]
            expected_shape = array_spec.get("shape")
            if expected_shape is not None and list(array.shape) != expected_shape:
                add(
                    "shape_mismatch",
                    rel,
                    "array " + key + " shape " + str(list(array.shape)) + " != expected " + str(expected_shape),
                    key,
                    {"actual": list(array.shape), "expected": expected_shape},
                )
            allowed_dtypes = array_spec.get("dtype") or []
            actual_dtype = str(array.dtype)
            if allowed_dtypes and actual_dtype not in allowed_dtypes:
                can_cast = False
                if payload.get("allowCast"):
                    can_cast = any(np.can_cast(array.dtype, np.dtype(dtype), casting="safe") for dtype in allowed_dtypes)
                if not can_cast:
                    add(
                        "dtype_mismatch",
                        rel,
                        "array " + key + " dtype " + actual_dtype + " not in " + str(allowed_dtypes),
                        key,
                        {"actual": actual_dtype, "expected": allowed_dtypes},
                    )
            if payload.get("finiteOnly") and not np.all(np.isfinite(array)):
                add("non_finite_values", rel, "array " + key + " contains NaN or Inf", key)
    finally:
        data.close()

print(json.dumps({"issues": issues}))
`
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(
      [
        input.python,
        '-c',
        script,
        JSON.stringify({
          files: input.files,
          arrays: input.arrays,
          finiteOnly: input.finiteOnly,
          allowCast: input.allowCast,
        }),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
  } catch (error) {
    return [
      {
        code: 'validator_runtime_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    ]
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    return [
      {
        code: 'validator_runtime_failed',
        message: stderr.trim() || `validator exited with code ${exitCode}`,
      },
    ]
  }
  try {
    const parsed = JSON.parse(stdout) as {
      issues?: SubmissionValidationIssue[]
      runtime_error?: string
    }
    if (parsed.runtime_error) {
      return [{ code: 'validator_runtime_failed', message: parsed.runtime_error }]
    }
    return parsed.issues ?? []
  } catch (error) {
    return [
      {
        code: 'validator_runtime_failed',
        message: `validator returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        details: { stdout, stderr },
      },
    ]
  }
}

export async function validateSubmission(
  input: ValidateSubmissionInput,
): Promise<SubmissionValidationResult> {
  const issues: SubmissionValidationIssue[] = []
  const schemaResult = await readJsonIfExists<OutputSchema>(schemaPath(input.taskRun))
  const casesResult = await readJsonIfExists<CasesConfig>(casesPath(input.taskRun))

  const schema = schemaResult.ok ? schemaResult.value : undefined
  const cases = casesResult.ok ? casesResult.value : undefined
  if (!schemaResult.ok) {
    issues.push({
      code: 'schema_read_failed',
      message: `failed to read output schema: ${schemaResult.error}`,
    })
  }
  if (!casesResult.ok) {
    issues.push({
      code: 'cases_read_failed',
      message: `failed to read visible cases: ${casesResult.error}`,
    })
  }

  const candidateFiles = new Set<string>([
    ...expectedFilesFromContract(schema, cases),
    ...input.files,
  ])
  const normalized = new Map<string, string>()
  for (const file of candidateFiles) {
    const resolved = normalizeOutputPath(input.taskRun, file)
    if (resolved.issue) {
      issues.push(resolved.issue)
      continue
    }
    if (resolved.rel && resolved.absolute) normalized.set(resolved.rel, resolved.absolute)
  }

  for (const [rel, absolute] of normalized) {
    if (!existsSync(absolute)) {
      issues.push({
        code: 'missing_output_file',
        path: rel,
        message: `missing output file ${rel}`,
      })
    }
  }

  const arrays = requiredArrays(schema)
  const existingFiles = [...normalized]
    .filter(([, absolute]) => existsSync(absolute))
    .map(([rel, absolute]) => ({ rel, absolute }))
  if (arrays.length > 0 && existingFiles.length > 0) {
    issues.push(
      ...(await validateNpzWithPython({
        python: input.runtime?.python ?? process.env.PYTHON ?? 'python',
        files: existingFiles,
        arrays,
        finiteOnly: schema?.validation?.finite_only !== false,
        allowCast: Boolean(schema?.validation?.allow_cast),
      })),
    )
  }

  return {
    ok: issues.length === 0,
    normalizedFiles: [...normalized.keys()].sort((a, b) => a.localeCompare(b)),
    issues,
  }
}
