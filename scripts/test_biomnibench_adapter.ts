/**
 * Sanity-check the BioMniBench adapter against the real task directory.
 *
 *   bun scripts/test_biomnibench_adapter.ts
 */
import { isBioMniBenchTask, loadBioMniBenchManifest, resolveSharedPython, SHARED_VENV_DIR, QWEN_JUDGE_SCRIPT } from '../src/harness/evaluation/biomnibenchAdapter.ts'
import { resolveTaskRuntime } from '../src/harness/evaluation/sourceRuntimeResolver.ts'
import { existsSync } from 'fs'

const BIOMNI_ROOT = '/data/yjh/biomnibench-organized'
const SAMPLES = ['da-1-3', 'da-3-1', 'da-14-1']

console.log('Shared venv:', SHARED_VENV_DIR, existsSync(SHARED_VENV_DIR) ? '✅' : '❌')
console.log('Shared Python:', resolveSharedPython(), '\n')
console.log('Qwen judge script:', QWEN_JUDGE_SCRIPT, existsSync(QWEN_JUDGE_SCRIPT) ? '✅' : '❌', '\n')

for (const id of SAMPLES) {
  const dir = `${BIOMNI_ROOT}/${id}`
  console.log(`=== ${id} (${dir}) ===`)
  console.log(`  exists: ${existsSync(dir) ? '✅' : '❌'}`)
  console.log(`  isBioMniBench: ${isBioMniBenchTask(dir)}`)
  if (existsSync(dir)) {
    const manifest = await loadBioMniBenchManifest(dir, id)
    console.log(`  manifest:`, JSON.stringify(manifest, null, 2))
  }

  // Simulate the publicDir lookup (no env_manifest.json present).
  const fakePublic = `${dir}` // we just check the resolver, not a real public/
  // resolveTaskRuntime expects publicDir; biomnibench tasks have no envs/runtime/.venv,
  // so we expect it to fall back to the shared venv.
  const runtime = await resolveTaskRuntime(fakePublic)
  console.log(`  resolveTaskRuntime.ok=${runtime.ok}`)
  if (runtime.ok) {
    console.log(`  resolveTaskRuntime.python=${runtime.python}`)
    console.log(`  resolveTaskRuntime.envName=${runtime.envName}`)
  } else {
    console.log(`  resolveTaskRuntime.error=${runtime.error}`)
  }
  console.log('')
}
