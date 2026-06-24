import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { mkdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ablateOracleSkillBundle,
  applyPriorityGreedyAblationRecord,
  planOracleSkillAblations,
} from './ablate.js'
import { parseOracleSkillsCliArgs } from './cli.js'
import { generateOracleSkillBundle } from './generate.js'
import { renderOracleSkillVariant } from './render.js'
import {
  loadOracleSkillManifest,
  resolveEnabledOperationIdsFromDropOps,
  validateOracleSkillBundle,
} from './manifest.js'

async function makeFixtureBundle(root: string): Promise<string> {
  return makeFixtureBundleWithOperations(root, [
    {
      id: 'op_010_contract',
      kind: 'contract',
      title: 'Read the public contract',
      depends_on: [],
      ablation_priority: 10,
    },
    {
      id: 'op_020_solver',
      kind: 'solver',
      title: 'Run the solver recipe',
      depends_on: ['op_010_contract'],
      ablation_priority: 20,
      scripts: ['scripts/op_020_probe.py'],
    },
  ])
}

type FixtureOperation = {
  id: string
  kind: string
  title: string
  depends_on: string[]
  ablation_priority: number
  scripts?: string[]
}

async function makeFixtureBundleWithOperations(
  root: string,
  operations: FixtureOperation[],
): Promise<string> {
  const bundle = join(root, 'bundle')
  const skillDir = join(bundle, 'skills', 'oracle-demo')
  await mkdir(join(skillDir, 'resources'), { recursive: true })
  await mkdir(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(
    join(bundle, 'oracle_skill_manifest.json'),
    JSON.stringify(
      {
        schema_version: 1,
        task_id: 'demo_task',
        skill_name: 'oracle-demo',
        operations: operations.map(op => ({
          id: op.id,
          kind: op.kind,
          title: op.title,
          skill_md_anchor: op.id,
          resources: [`resources/${op.id}.md`],
          scripts: op.scripts ?? [],
          depends_on: op.depends_on,
          ablation_priority: op.ablation_priority,
          enabled_by_default: true,
        })),
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: oracle-demo',
      'description: Demo oracle skill',
      '---',
      '',
      '# Demo Oracle Skill',
      '',
      ...operations.flatMap(op => [
        `<!-- ORACLE_OP_START ${op.id} -->`,
        `## ${op.title}`,
        `Read \`resources/${op.id}.md\`.`,
        `<!-- ORACLE_OP_END ${op.id} -->`,
        '',
      ]),
      '',
    ].join('\n'),
  )
  for (const op of operations) {
    writeFileSync(join(skillDir, 'resources', `${op.id}.md`), `# ${op.title}`)
    for (const script of op.scripts ?? []) {
      writeFileSync(join(skillDir, script), 'print("probe")\n')
    }
  }
  return bundle
}

describe('oracle skill bundles', () => {
  test('validates manifests, anchors, resources, scripts, and dependencies', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-validate-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const result = await validateOracleSkillBundle(bundle)

      expect(result.ok).toBe(true)
      expect(result.issues).toEqual([])
      expect((await loadOracleSkillManifest(bundle)).skill_name).toBe('oracle-demo')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('renders exact enabled operation sets without dependency pruning', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-render-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const out = join(temp, 'variant')
      const variant = await renderOracleSkillVariant({
        bundleDir: bundle,
        outDir: out,
        enabledOperationIds: ['op_020_solver'],
      })

      const skillMd = readFileSync(join(out, 'skills', 'oracle-demo', 'SKILL.md'), 'utf8')
      expect(variant.enabled_ops).toEqual(['op_020_solver'])
      expect(variant.disabled_ops.map(item => item.id).sort()).toEqual([
        'op_010_contract',
      ])
      expect(skillMd).not.toContain('## Contract')
      expect(skillMd).toContain('## Run the solver recipe')
      expect(existsSync(join(out, 'skills', 'oracle-demo', 'resources', 'op_010_contract.md'))).toBe(false)
      expect(existsSync(join(out, 'variant_manifest.json'))).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('renders solver-facing skills without operation ids, anchors, or op-named assets', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-private-ids-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const out = join(temp, 'variant')
      await renderOracleSkillVariant({
        bundleDir: bundle,
        outDir: out,
        enabledOperationIds: ['op_010_contract', 'op_020_solver'],
      })

      const skillRoot = join(out, 'skills', 'oracle-demo')
      const skillMd = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
      expect(skillMd).toContain('## Read the public contract')
      expect(skillMd).toContain('## Run the solver recipe')
      expect(skillMd).not.toContain('op_010_contract')
      expect(skillMd).not.toContain('op_020_solver')
      expect(skillMd).not.toContain('ORACLE_OP_START')
      expect(skillMd).not.toContain('ORACLE_OP_END')
      expect(skillMd).not.toContain('resources/op_')
      expect(existsSync(join(skillRoot, 'resources', 'op_010_contract.md'))).toBe(false)
      expect(existsSync(join(skillRoot, 'resources', 'resource_001.md'))).toBe(true)
      expect(existsSync(join(skillRoot, 'scripts', 'op_020_probe.py'))).toBe(false)
      expect(existsSync(join(skillRoot, 'scripts', 'script_001.py'))).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects solver-facing pipeline summaries in rendered skills', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-pipeline-summary-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const skillPath = join(bundle, 'skills', 'oracle-demo', 'SKILL.md')
      writeFileSync(
        skillPath,
        readFileSync(skillPath, 'utf8').replace(
          '# Demo Oracle Skill\n\n',
          '# Demo Oracle Skill\n\nData flow: read the contract, then run the solver.\n\n',
        ),
      )

      await expect(
        renderOracleSkillVariant({
          bundleDir: bundle,
          outDir: join(temp, 'variant'),
          enabledOperationIds: ['op_010_contract'],
        }),
      ).rejects.toThrow('pipeline summary')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('ablation renders full, single-drop, and cumulative greedy variants', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-ablate-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const out = join(temp, 'ablations')
      const result = await ablateOracleSkillBundle({
        bundleDir: bundle,
        outDir: out,
      })

      expect(result.variants.map(item => item.semantic_name)).toEqual([
        'full',
        'drop_op_020_solver',
        'drop_op_010_contract',
        'greedy_step_01_drop_op_020_solver',
        'greedy_step_02_drop_op_010_contract',
      ])
      expect(result.variants.every(item => /^v_[0-9a-f]{12}$/.test(item.name))).toBe(true)
      expect(result.variants.some(item => item.name.includes('op_'))).toBe(false)
      expect(new Set(result.variants.map(item => item.name)).size).toBe(result.variants.length)
      expect(readFileSync(join(out, 'metadata', 'variants', `${result.variants[0]!.name}.eval_command.txt`), 'utf8')).toContain(
        '--enable-skills --skills-dir',
      )
      expect(existsSync(join(out, 'ablation_manifest.json'))).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('plans greedy deletions by ablation priority regardless of dependencies', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-leaf-plan-'))
    try {
      const bundle = await makeFixtureBundleWithOperations(temp, [
        {
          id: 'op_010_contract',
          kind: 'contract',
          title: 'Contract',
          depends_on: [],
          ablation_priority: 100,
        },
        {
          id: 'op_020_solver',
          kind: 'solver',
          title: 'Solver',
          depends_on: ['op_010_contract'],
          ablation_priority: 50,
        },
        {
          id: 'op_030_output',
          kind: 'postprocess',
          title: 'Output',
          depends_on: ['op_020_solver'],
          ablation_priority: 1,
        },
      ])

      const plan = await planOracleSkillAblations({ bundleDir: bundle })

      expect(plan.filter(item => item.kind === 'greedy_step').map(item => item.semanticName)).toEqual([
        'greedy_step_01_drop_op_010_contract',
        'greedy_step_02_drop_op_020_solver',
        'greedy_step_03_drop_op_030_output',
      ])
      expect(plan.every(item => /^v_[0-9a-f]{12}$/.test(item.name))).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('greedy priority deletions do not cascade through dependencies', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-leaf-ablate-'))
    try {
      const bundle = await makeFixtureBundleWithOperations(temp, [
        {
          id: 'op_010_base',
          kind: 'contract',
          title: 'Base',
          depends_on: [],
          ablation_priority: 100,
        },
        {
          id: 'op_020_left',
          kind: 'solver',
          title: 'Left branch',
          depends_on: ['op_010_base'],
          ablation_priority: 10,
        },
        {
          id: 'op_030_right',
          kind: 'solver',
          title: 'Right branch',
          depends_on: ['op_010_base'],
          ablation_priority: 20,
        },
        {
          id: 'op_040_final',
          kind: 'postprocess',
          title: 'Final output',
          depends_on: ['op_020_left', 'op_030_right'],
          ablation_priority: 5,
        },
      ])
      const result = await ablateOracleSkillBundle({
        bundleDir: bundle,
        outDir: join(temp, 'ablations'),
      })

      const greedy = result.variants.filter(item => item.kind === 'greedy_step')
      expect(greedy.map(item => item.semantic_name)).toEqual([
        'greedy_step_01_drop_op_010_base',
        'greedy_step_02_drop_op_030_right',
        'greedy_step_03_drop_op_020_left',
        'greedy_step_04_drop_op_040_final',
      ])
      for (let index = 0; index < greedy.length; index++) {
        expect(greedy[index].disabled_ops).toHaveLength(index + 1)
        expect(greedy[index].disabled_ops.every(item => item.reason === 'disabled_by_request')).toBe(true)
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('fixed drop ablation planning produces exactly one exact-drop variant', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-fixed-drop-plan-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const plan = await planOracleSkillAblations({
        bundleDir: bundle,
        dropOperationIds: ['op_010_contract'],
      })

      expect(plan).toHaveLength(1)
      expect(plan[0]).toMatchObject({
        semanticName: 'fixed_drop_set',
        kind: 'fixed_drop',
        drop_ops: ['op_010_contract'],
        enabledOperationIds: ['op_020_solver'],
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('priority greedy records accept only successful candidate deletions', () => {
    expect(
      applyPriorityGreedyAblationRecord(['op_010_base'], {
        drop_op: 'op_020_child',
        result_type: 'pass',
      }),
    ).toEqual({
      accepted: true,
      acceptedDropOps: ['op_010_base', 'op_020_child'],
    })

    expect(
      applyPriorityGreedyAblationRecord(['op_010_base'], {
        drop_op: 'op_020_child',
        result_type: 'valid_fail',
      }),
    ).toEqual({
      accepted: false,
      acceptedDropOps: ['op_010_base'],
    })
  })

  test('renders variant metadata outside the solver-facing variant directory', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-render-external-manifest-'))
    try {
      const bundle = await makeFixtureBundle(temp)
      const out = join(temp, 'variant')
      const manifestPath = join(temp, 'metadata', 'variants', 'v_demo.json')
      await renderOracleSkillVariant({
        bundleDir: bundle,
        outDir: out,
        enabledOperationIds: ['op_010_contract'],
        variantManifestPath: manifestPath,
      })

      expect(existsSync(join(out, 'variant_manifest.json'))).toBe(false)
      expect(existsSync(manifestPath)).toBe(true)
      expect(readFileSync(manifestPath, 'utf8')).toContain('op_020_solver')
      expect(existsSync(join(out, 'skills', 'oracle-demo', 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('resolves explicit drop ops exactly without cascading to dependents', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-drop-ops-'))
    try {
      const bundle = await makeFixtureBundleWithOperations(temp, [
        {
          id: 'op_010_base',
          kind: 'contract',
          title: 'Base',
          depends_on: [],
          ablation_priority: 100,
        },
        {
          id: 'op_020_child',
          kind: 'solver',
          title: 'Child',
          depends_on: ['op_010_base'],
          ablation_priority: 10,
        },
        {
          id: 'op_030_leaf',
          kind: 'solver',
          title: 'Leaf',
          depends_on: ['op_020_child'],
          ablation_priority: 5,
        },
      ])
      const manifest = await loadOracleSkillManifest(bundle)

      expect(
        resolveEnabledOperationIdsFromDropOps(manifest, ['op_020_child']),
      ).toEqual(['op_010_base', 'op_030_leaf'])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('drop-op render drops only requested operations without unsafe metadata', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-unsafe-drop-'))
    try {
      const bundle = await makeFixtureBundleWithOperations(temp, [
        {
          id: 'op_010_base',
          kind: 'contract',
          title: 'Base',
          depends_on: [],
          ablation_priority: 100,
        },
        {
          id: 'op_020_child',
          kind: 'solver',
          title: 'Child',
          depends_on: ['op_010_base'],
          ablation_priority: 10,
        },
        {
          id: 'op_030_leaf',
          kind: 'solver',
          title: 'Leaf',
          depends_on: ['op_020_child'],
          ablation_priority: 5,
        },
      ])
      const variant = await renderOracleSkillVariant({
        bundleDir: bundle,
        outDir: join(temp, 'variant'),
        dropOperationIds: ['op_020_child'],
      })

      const skillMd = readFileSync(join(temp, 'variant', 'skills', 'oracle-demo', 'SKILL.md'), 'utf8')
      expect(skillMd).toContain('## Base')
      expect(skillMd).not.toContain('## Child')
      expect(skillMd).toContain('## Leaf')
      expect(variant.enabled_ops).toEqual(['op_010_base', 'op_030_leaf'])
      expect(variant.disabled_ops).toEqual([
        { id: 'op_020_child', reason: 'disabled_by_request' },
      ])
      expect('unsafe_allow_dangling' in variant).toBe(false)
      expect('dangling_dependencies' in variant).toBe(false)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('generates a complete scaffold bundle from a task standard implementation', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-skill-generate-'))
    try {
      const tasksDir = join(temp, 'tasks')
      const taskDir = join(tasksDir, 'demo_task')
      await mkdir(join(taskDir, 'std_code', 'src'), { recursive: true })
      await mkdir(join(taskDir, 'visible_data'), { recursive: true })
      writeFileSync(join(taskDir, 'README.md'), '# Demo task\nUse the demo solver.')
      writeFileSync(join(taskDir, 'output_schema.json'), JSON.stringify({ arrays: [{ key: 'x' }] }))
      writeFileSync(join(taskDir, 'visible_data', 'cases.json'), JSON.stringify({ cases: [{ id: 'case_0' }] }))
      writeFileSync(join(taskDir, 'std_code', 'main.py'), 'from src.solver import solve\nsolve()\n')
      writeFileSync(join(taskDir, 'std_code', 'src', 'solver.py'), 'def solve():\n    return 1\n')

      const bundle = await generateOracleSkillBundle({
        taskId: 'demo_task',
        tasksDir,
        outDir: join(temp, 'bundle'),
        mode: 'template',
      })

      expect((await validateOracleSkillBundle(bundle.bundleDir)).ok).toBe(true)
      expect(existsSync(join(bundle.bundleDir, 'source_index.json'))).toBe(true)
      expect(existsSync(join(bundle.bundleDir, 'skills', bundle.skillName, 'SKILL.md'))).toBe(true)
      expect(await readFile(join(bundle.bundleDir, 'skills', bundle.skillName, 'resources', 'op_030_reference_notes.md'), 'utf8')).toContain('main.py')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('parses CLI commands without eval-specific switches', () => {
    expect(
      parseOracleSkillsCliArgs([
        'ablate',
        '--bundle',
        'output/oracle-skills/demo/full',
        '--out',
        'output/oracle-skills/demo/ablations',
        '--dry-run',
      ]),
    ).toEqual({
      command: 'ablate',
      bundleDir: 'output/oracle-skills/demo/full',
      outDir: 'output/oracle-skills/demo/ablations',
      dryRun: true,
    })
  })

  test('parses drop-op based render and fixed ablation commands', () => {
    expect(
      parseOracleSkillsCliArgs([
        'render',
        '--bundle',
        'output/oracle-skills/demo/full',
        '--out',
        'output/oracle-skills/demo/variant',
        '--drop-ops',
        'op_a,op_b',
      ]),
    ).toEqual({
      command: 'render',
      bundleDir: 'output/oracle-skills/demo/full',
      outDir: 'output/oracle-skills/demo/variant',
      dropOps: ['op_a,op_b'],
      variantManifestPath: undefined,
    })

    expect(
      parseOracleSkillsCliArgs([
        'ablate',
        '--bundle',
        'output/oracle-skills/demo/full',
        '--out',
        'output/oracle-skill-ablation/demo',
        '--task',
        'demo_task',
        '--drop-ops',
        'op_a',
      ]),
    ).toEqual({
      command: 'ablate',
      bundleDir: 'output/oracle-skills/demo/full',
      outDir: 'output/oracle-skill-ablation/demo',
      taskId: 'demo_task',
      dropOps: ['op_a'],
      dryRun: false,
    })

    expect(() =>
      parseOracleSkillsCliArgs([
        'render',
        '--bundle',
        'output/oracle-skills/demo/full',
        '--enabled-ops',
        'op_a',
        '--drop-ops',
        'op_b',
      ]),
    ).toThrow('mutually exclusive')
  })

  test('rejects legacy dangling render flag', () => {
    expect(() =>
      parseOracleSkillsCliArgs([
        'render',
        '--bundle',
        'output/oracle-skills/demo/full',
        '--out',
        'output/oracle-skills/demo/variant',
        '--drop-ops',
        'op_a',
        '--unsafe-allow-dangling',
      ]),
    ).toThrow('Unknown argument: --unsafe-allow-dangling')
  })

  test('parses generate model profile switches like eval config runner', () => {
    expect(
      parseOracleSkillsCliArgs([
        'generate',
        '--task',
        'SSNP_ODT',
        '--out',
        'output/oracle-skills/SSNP_ODT',
        '--model-config',
        'config/eval-model-profiles.local.json',
        '--model-profile',
        'gpugeek-claude-opus',
      ]),
    ).toMatchObject({
      command: 'generate',
      taskId: 'SSNP_ODT',
      outDir: 'output/oracle-skills/SSNP_ODT',
      modelConfigPath: 'config/eval-model-profiles.local.json',
      modelProfile: 'gpugeek-claude-opus',
    })
  })
})
