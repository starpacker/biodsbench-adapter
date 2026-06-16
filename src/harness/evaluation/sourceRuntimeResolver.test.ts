import { existsSync } from 'fs'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, test } from 'bun:test'
import { resolveTaskRuntime } from './sourceRuntimeResolver.js'

async function makePublicDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'source-runtime-'))
}

describe('resolveTaskRuntime', () => {
  test('fails before agent startup when env_manifest points at a missing Python', async () => {
    const publicDir = await makePublicDir()
    await mkdir(join(publicDir, 'envs'), { recursive: true })
    await writeFile(
      join(publicDir, 'envs', 'env_manifest.json'),
      JSON.stringify({
        default_env: 'runtime',
        envs: {
          runtime: {
            python: {
              windows: 'envs/runtime/.venv/Scripts/python.exe',
              posix: 'envs/runtime/.venv/bin/python',
            },
          },
        },
      }),
      'utf8',
    )

    const runtime = await resolveTaskRuntime(publicDir)

    expect(runtime.ok).toBe(false)
    if (!runtime.ok) {
      expect(runtime.error).toContain('Unable to resolve task Python')
      expect(runtime.checked.length).toBeGreaterThan(0)
    }
  })

  test('uses the configured platform Python when it exists', async () => {
    const publicDir = await makePublicDir()
    const pythonRel =
      process.platform === 'win32'
        ? 'envs/runtime/.venv/Scripts/python.exe'
        : 'envs/runtime/.venv/bin/python'
    const pythonAbs = join(publicDir, ...pythonRel.split('/'))
    await mkdir(dirname(pythonAbs), { recursive: true })
    await writeFile(pythonAbs, '', 'utf8')
    await mkdir(join(publicDir, 'envs'), { recursive: true })
    await writeFile(
      join(publicDir, 'envs', 'env_manifest.json'),
      JSON.stringify({
        default_env: 'runtime',
        envs: {
          runtime: {
            python: {
              [process.platform === 'win32' ? 'windows' : 'posix']: pythonRel,
            },
          },
        },
      }),
      'utf8',
    )

    const runtime = await resolveTaskRuntime(publicDir)

    expect(runtime.ok).toBe(true)
    if (runtime.ok) {
      expect(existsSync(runtime.python)).toBe(true)
      expect(runtime.displayPath).toContain('public/')
    }
  })

  test('rejects configured Python paths outside the public bundle', async () => {
    const publicDir = await makePublicDir()
    const outsideDir = await makePublicDir()
    const outsidePython = join(outsideDir, 'python')
    await writeFile(outsidePython, '', 'utf8')
    await mkdir(join(publicDir, 'envs'), { recursive: true })
    await writeFile(
      join(publicDir, 'envs', 'env_manifest.json'),
      JSON.stringify({
        default_env: 'runtime',
        envs: {
          runtime: {
            python: {
              [process.platform === 'win32' ? 'windows' : 'posix']: outsidePython,
            },
          },
        },
      }),
      'utf8',
    )

    const runtime = await resolveTaskRuntime(publicDir)

    expect(runtime.ok).toBe(false)
    if (!runtime.ok) {
      expect(runtime.error).toContain('outside public/')
    }
  })
})
