/**
 * biomnibenchAdapter.ts
 *
 * Adapter for BioMniBench-organized tasks (Docker-based data analysis tasks
 * with `da-X-Y/` structure). These tasks differ from the imaging task format
 * that `my_claude` was originally designed for:
 *
 *   Imaging tasks (original):                BioMniBench tasks (this adapter):
 *   - envs/env_manifest.json                 - envs/Dockerfile (no manifest)
 *   - envs/runtime/.venv/bin/python          - shared venv at <repoRoot>/shared_venv
 *   - output_schema.json                     - README.md (free-form output)
 *   - visible_data/cases.json                - visible_data/ (raw data files)
 *   - evaluation/judge.py                    - evaluation/llm_judge.py + rubric.txt
 *   - submission as outputs/*.npz            - submission as trace.md + answer.txt
 *   - full task_manifest.json                - minimal task_manifest.json (only task_id)
 *
 * Detection is conservative: a task is treated as BioMniBench when the task
 * directory contains BOTH `envs/Dockerfile` and `evaluation/rubric.txt`. Tasks
 * that look like imaging tasks (env_manifest.json present) always take the
 * legacy code path.
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { TaskManifest } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Repository root for my_claude_biomnibench (3 levels above this file). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/** Default shared Python venv (conda env via symlink) used by all biomnibench tasks. */
export const SHARED_VENV_DIR = resolve(REPO_ROOT, 'shared_venv')

/** Path to the qwen-backed LLM judge script bundled with the harness. */
export const QWEN_JUDGE_SCRIPT = resolve(REPO_ROOT, 'llm_judge_qwen.py')

/** Heuristic detection of a BioMniBench-organized task directory. */
export function isBioMniBenchTask(taskDir: string): boolean {
  const dockerfile = join(taskDir, 'envs', 'Dockerfile')
  const rubric = join(taskDir, 'evaluation', 'rubric.txt')
  const envManifest = join(taskDir, 'envs', 'env_manifest.json')
  // If env_manifest.json is present, treat as imaging task (legacy path).
  if (existsSync(envManifest)) return false
  return existsSync(dockerfile) && existsSync(rubric)
}

/** Resolve the Python interpreter to use for a BioMniBench task. */
export function resolveSharedPython(): string | null {
  const candidates = [
    join(SHARED_VENV_DIR, 'bin', 'python'),
    join(SHARED_VENV_DIR, 'bin', 'python3'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Construct an in-memory `TaskManifest` for a BioMniBench task. The on-disk
 * `task_manifest.json` only contains the task id; this synthesises the fields
 * the rest of the harness depends on.
 */
export function buildBioMniBenchManifest(taskId: string): TaskManifest {
  return {
    version: 1,
    task_id: taskId,
    public_bundle: [
      'README.md',
      'data',
      'visible_data',
    ],
    private_judge_bundle: ['evaluation/'],
    entrypoints: {
      judge: 'evaluation/llm_judge.py',
    },
    submission: {
      output_dir: 'outputs',
    },
  }
}

/** Read and merge an on-disk task_manifest.json with the synthesized one. */
export async function loadBioMniBenchManifest(taskDir: string, taskId: string): Promise<TaskManifest> {
  const synthesised = buildBioMniBenchManifest(taskId)
  const manifestPath = join(taskDir, 'task_manifest.json')
  if (!existsSync(manifestPath)) return synthesised
  try {
    const raw = await readFile(manifestPath, 'utf8')
    const onDisk = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Partial<TaskManifest>
    return {
      ...synthesised,
      ...onDisk,
      task_id: taskId,
      // Always keep the synthesised entrypoints/submission unless caller already set them.
      entrypoints: { ...synthesised.entrypoints, ...(onDisk.entrypoints ?? {}) },
      submission: { ...synthesised.submission, ...(onDisk.submission ?? {}) },
      public_bundle: onDisk.public_bundle ?? synthesised.public_bundle,
      private_judge_bundle: onDisk.private_judge_bundle ?? synthesised.private_judge_bundle,
    }
  } catch {
    return synthesised
  }
}

/** Build the initial agent prompt for a BioMniBench task using the README. */
export async function buildBioMniBenchSystemContext(taskDir: string): Promise<string> {
  const readmePath = join(taskDir, 'README.md')
  let readme = ''
  try {
    readme = await readFile(readmePath, 'utf8')
  } catch {
    readme = '(no README available)'
  }
  return readme
}
