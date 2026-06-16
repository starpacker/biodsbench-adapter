import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveTaskPython } from './judgeRunner.js'

describe('resolveTaskPython', () => {
  test('uses env_manifest platform-specific python path', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'judge-python-'))
    try {
      const publicDir = join(temp, 'public')
      await mkdir(join(publicDir, 'envs', 'runtime', '.venv', 'Scripts'), {
        recursive: true,
      })
      await mkdir(join(publicDir, 'envs', 'runtime', '.venv', 'bin'), {
        recursive: true,
      })
      const windowsPython = join(
        publicDir,
        'envs',
        'runtime',
        '.venv',
        'Scripts',
        'python.exe',
      )
      const posixPython = join(
        publicDir,
        'envs',
        'runtime',
        '.venv',
        'bin',
        'python',
      )
      writeFileSync(windowsPython, '')
      writeFileSync(posixPython, '')
      writeFileSync(
        join(publicDir, 'envs', 'env_manifest.json'),
        JSON.stringify({
          version: 1,
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
      )

      const resolved = await resolveTaskPython(publicDir)
      expect(existsSync(resolved)).toBe(true)
      expect(resolved.endsWith(process.platform === 'win32' ? 'python.exe' : 'python')).toBe(
        true,
      )
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
