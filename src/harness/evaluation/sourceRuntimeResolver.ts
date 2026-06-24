import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import type { RuntimeResolution } from './types.js'

type EnvManifest = {
  default_env?: string
  envs?: Record<
    string,
    {
      python?: {
        windows?: string
        posix?: string
      }
    }
  >
}

function stripUtf8Bom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function platformPythonKey(): 'windows' | 'posix' {
  return process.platform === 'win32' ? 'windows' : 'posix'
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  return JSON.parse(stripUtf8Bom(await readFile(path, 'utf8'))) as T
}

function resolveMaybeRelative(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
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

function displayPath(publicDir: string, absolutePath: string): string {
  const rel = relative(publicDir, absolutePath).replace(/\\/g, '/')
  return rel.startsWith('..') ? absolutePath : `public/${rel}`
}

export async function resolveTaskRuntime(publicDir: string): Promise<RuntimeResolution> {
  const manifestPath = join(publicDir, 'envs', 'env_manifest.json')
  const manifest = await readJsonIfExists<EnvManifest>(manifestPath)
  const envName = manifest?.default_env ?? 'runtime'
  const platformKey = platformPythonKey()
  const checked: string[] = []
  const configuredPython =
    manifest?.envs?.[envName]?.python?.[platformKey] ??
    manifest?.envs?.runtime?.python?.[platformKey]
  const configuredPath = configuredPython
    ? resolveMaybeRelative(publicDir, configuredPython)
    : undefined

  if (configuredPath && !isInside(configuredPath, publicDir)) {
    return {
      ok: false,
      error: `Configured task Python is outside public/: ${configuredPython}`,
      checked: [configuredPath],
    }
  }

  const candidates = Array.from(new Set([
    configuredPath,
    join(
      publicDir,
      'envs',
      'runtime',
      process.platform === 'win32'
        ? '.venv/Scripts/python.exe'
        : '.venv/bin/python',
    ),
    join(
      publicDir,
      'envs',
      'runtime',
      process.platform === 'win32'
        ? '.venv/Scripts/python.exe'
        : '.venv-posix/bin/python',
    ),
  ].filter((value): value is string => Boolean(value))))

  for (const candidate of candidates) {
    const absolutePath = resolve(candidate)
    checked.push(absolutePath)
    if (existsSync(absolutePath)) {
      return {
        ok: true,
        python: absolutePath,
        displayPath: displayPath(publicDir, absolutePath),
        envName,
        checked,
      }
    }
  }

  return {
    ok: false,
    error: `Unable to resolve task Python from ${manifestPath}; checked configured and fallback runtime paths.`,
    checked,
  }
}
