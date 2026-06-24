import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { mkdir, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createOracleSkillAuthorCanUseTool } from './authorCanUseTool.js'
import { generateOracleSkillBundle } from './generate.js'
import { materializeOracleSkillDraft } from './materialize.js'
import {
  ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT,
  buildOracleSkillAuthorUserPrompt,
  buildOracleSkillRepairPrompt,
} from './prompts.js'
import { ORACLE_SKILL_DRAFT_JSON_SCHEMA } from './schema.js'
import { loadOracleSkillManifest, validateOracleSkillBundle } from './manifest.js'
import { QueryEngineOracleSkillAuthorSession } from './queryEngineAuthor.js'
import type { OracleSkillDraft, OracleSkillAuthorSession } from './types.js'

function demoDraft(overrides: Partial<OracleSkillDraft> = {}): OracleSkillDraft {
  return {
    schema_version: 1,
    task_id: 'demo_task',
    skill_name: 'oracle-demo-task',
    skill_description: 'Use when solving the demo task with oracle distilled guidance',
    skill_overview: 'Apply the extracted demo solver contract and output rules.',
    operations: [
      {
        id: 'op_010_contract',
        kind: 'contract',
        title: 'Extract the public contract',
        depends_on: [],
        ablation_priority: 30,
        enabled_by_default: true,
        source_refs: ['std_code/main.py'],
        skill_md: 'Read `resources/op_010_contract.md` and write the public contract before coding.',
        resources: [
          {
            path: 'resources/op_010_contract.md',
            content: '# Contract\nUse `public/output_schema.json` and visible cases.\n',
          },
        ],
        scripts: [],
      },
      {
        id: 'op_020_solver',
        kind: 'solver',
        title: 'Run the demo solver',
        depends_on: ['op_010_contract'],
        ablation_priority: 10,
        enabled_by_default: true,
        source_refs: ['std_code/src/solver.py'],
        skill_md: 'Read `resources/op_020_solver.md`, run `python ${CLAUDE_SKILL_DIR}/scripts/op_020_probe.py`, then implement the solver under `workspace/`.',
        resources: [
          {
            path: 'resources/op_020_solver.md',
            content: '# Solver\nReturn an array named `x` for each visible case.\n',
          },
        ],
        scripts: [
          {
            path: 'scripts/op_020_probe.py',
            content: 'print("probe ok")\n',
          },
        ],
      },
    ],
    self_check: {
      atomicity_notes: ['contract and solver are separately removable'],
      safety_notes: ['solver-facing content uses only run-local paths'],
      likely_critical_ops: ['op_020_solver'],
      likely_removable_ops: ['op_010_contract'],
    },
    ...overrides,
  }
}

async function makeTask(root: string): Promise<{ tasksDir: string; taskDir: string }> {
  const tasksDir = join(root, 'tasks')
  const taskDir = join(tasksDir, 'demo_task')
  await mkdir(join(taskDir, 'std_code', 'src'), { recursive: true })
  await mkdir(join(taskDir, 'visible_data'), { recursive: true })
  writeFileSync(join(taskDir, 'README.md'), '# Demo task\nUse the demo solver.')
  writeFileSync(join(taskDir, 'output_schema.json'), JSON.stringify({ arrays: [{ key: 'x' }] }))
  writeFileSync(join(taskDir, 'visible_data', 'cases.json'), JSON.stringify({ cases: [{ id: 'case_0' }] }))
  writeFileSync(join(taskDir, 'std_code', 'main.py'), 'from src.solver import solve\nsolve()\n')
  writeFileSync(join(taskDir, 'std_code', 'src', 'solver.py'), 'def solve():\n    return 1\n')
  return { tasksDir, taskDir }
}

describe('oracle skill authoring prompts and schema', () => {
  test('system prompt defines QueryEngine authoring, StructuredOutput, and safety boundary', () => {
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('QueryEngine')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('StructuredOutput')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('Atomic operation')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('std_code')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('private_judge')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('${CLAUDE_SKILL_DIR}')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).not.toContain('$CLAUDE_SKILL_DIR')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('Operation IDs are internal authoring keys')
    expect(ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT).toContain('Do not put a global Data flow or Pipeline summary')
  })

  test('user and repair prompts carry task context and validation errors', () => {
    const userPrompt = buildOracleSkillAuthorUserPrompt({
      taskId: 'demo_task',
      taskDir: 'tasks/demo_task',
      skillName: 'oracle-demo-task',
      authorWorkspace: 'output/oracle/.authoring/workspace',
      readmeExcerpt: '# Demo',
      outputSchemaExcerpt: '{"arrays":[]}',
      visibleCasesExcerpt: '{"cases":[]}',
      publicFileManifest: '- README.md',
      standardSourceManifest: '- std_code/main.py bytes=10 sha256=abc',
      maxOperations: 14,
    })
    expect(userPrompt).toContain('<authoring_context>')
    expect(userPrompt).toContain('task_id: demo_task')
    expect(userPrompt).toContain('std_code')
    expect(userPrompt).toContain('StructuredOutput')
    expect(userPrompt).toContain('max_operation_count: 14')
    expect(userPrompt).toContain('directed acyclic graph')

    const repairPrompt = buildOracleSkillRepairPrompt([{ code: 'bad', message: 'fix me' }])
    expect(repairPrompt).toContain('<validation_errors>')
    expect(repairPrompt).toContain('fix me')
  })

  test('draft schema requires operations and structured self check', () => {
    expect(ORACLE_SKILL_DRAFT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['schema_version', 'task_id', 'skill_name', 'operations', 'self_check']),
      properties: {
        operations: {
          maxItems: 14,
        },
      },
    })
  })
})

describe('oracle skill draft materialization', () => {
  test('materializes a structured draft into a valid bundle', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-'))
    try {
      const outDir = join(temp, 'bundle')
      await materializeOracleSkillDraft({
        draft: demoDraft(),
        outDir,
        sourceIndex: {
          schema_version: 1,
          task_id: 'demo_task',
          source_root: 'std_code',
          files: [],
        },
      })

      const validation = await validateOracleSkillBundle(outDir)
      expect(validation.ok).toBe(true)
      const manifest = await loadOracleSkillManifest(outDir)
      expect(manifest.operations.map(op => op.id)).toEqual(['op_010_contract', 'op_020_solver'])
      expect(manifest.operations[0]?.source_refs).toEqual(['std_code/main.py'])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects forbidden solver-facing tokens before writing a bundle', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-forbidden-'))
    try {
      const bad = demoDraft()
      bad.operations[0]!.resources[0]!.content = 'Open std_code/main.py directly.'
      await expect(
        materializeOracleSkillDraft({ draft: bad, outDir: join(temp, 'bundle') }),
      ).rejects.toThrow('forbidden token')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects global operation summaries before writing a bundle', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-global-summary-'))
    try {
      const bad = demoDraft({
        skill_overview: 'Data flow: read the contract, then run the solver.',
      })
      await expect(
        materializeOracleSkillDraft({ draft: bad, outDir: join(temp, 'bundle') }),
      ).rejects.toThrow('pipeline summary')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects drafts with too many atomic operations', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-too-many-'))
    try {
      const operations = Array.from({ length: 15 }, (_, index) => {
        const number = String((index + 1) * 10).padStart(3, '0')
        const id = `op_${number}_node`
        return {
          id,
          kind: 'solver' as const,
          title: `Node ${index + 1}`,
          depends_on: index === 0 ? [] : [`op_${String(index * 10).padStart(3, '0')}_node`],
          ablation_priority: 15 - index,
          enabled_by_default: true as const,
          source_refs: [],
          skill_md: `Read \`resources/${id}.md\`.`,
          resources: [{ path: `resources/${id}.md`, content: `# ${id}\n` }],
          scripts: [],
        }
      })
      await expect(
        materializeOracleSkillDraft({
          draft: demoDraft({ operations }),
          outDir: join(temp, 'bundle'),
        }),
      ).rejects.toThrow('draft_too_many_operations')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects dependencies that point to later operations', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-dep-order-'))
    try {
      const bad = demoDraft()
      bad.operations[0]!.depends_on = ['op_020_solver']
      await expect(
        materializeOracleSkillDraft({ draft: bad, outDir: join(temp, 'bundle') }),
      ).rejects.toThrow('draft_dependency_order')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('rejects cross-operation references without declared dependencies', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-materialize-cross-ref-'))
    try {
      const bad = demoDraft()
      bad.operations[0]!.skill_md = 'Read `resources/op_020_solver.md` even though it is not a dependency.'
      await expect(
        materializeOracleSkillDraft({ draft: bad, outDir: join(temp, 'bundle') }),
      ).rejects.toThrow('draft_cross_operation_reference')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe('oracle skill author tool policy', () => {
  test('allows current task standard source reads but denies other privileged paths', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-author-policy-'))
    try {
      const { taskDir } = await makeTask(temp)
      const policy = createOracleSkillAuthorCanUseTool({
        taskDir,
        authorWorkspaceDir: join(temp, 'bundle', '.authoring', 'workspace'),
      })
      const allowRead = await policy({ name: 'Read' } as never, { file_path: join(taskDir, 'std_code', 'main.py') }, {} as never, {} as never, 'tool-1')
      expect(allowRead.behavior).toBe('allow')

      const denyEval = await policy({ name: 'Read' } as never, { file_path: join(taskDir, 'evaluation', 'judge.py') }, {} as never, {} as never, 'tool-2')
      expect(denyEval.behavior).toBe('deny')

      const denyOtherTask = await policy({ name: 'Read' } as never, { file_path: join(temp, 'tasks', 'other', 'std_code', 'main.py') }, {} as never, {} as never, 'tool-3')
      expect(denyOtherTask.behavior).toBe('deny')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})

describe('oracle skill QueryEngine generation path', () => {
  function makeShellTask(
    id: string,
    callbacks: {
      killed: string[]
      cleaned: string[]
      unregistered: string[]
    },
  ) {
    const shellCommand = {
      kill: () => callbacks.killed.push(id),
      cleanup: () => callbacks.cleaned.push(id),
      result: Promise.resolve({
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
      }),
      status: 'backgrounded',
    } as never

    return {
      id,
      type: 'local_bash',
      status: 'running',
      description: id,
      startTime: Date.now(),
      outputFile: `${id}.output`,
      outputOffset: 0,
      notified: false,
      command: `python ${id}.py`,
      completionStatusSentInAttachment: false,
      shellCommand,
      unregisterCleanup: () => callbacks.unregistered.push(id),
      lastReportedTotalLines: 0,
      isBackgrounded: true,
    } as never
  }

  test('QueryEngine author session dispose kills running local Bash tasks', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-author-dispose-'))
    try {
      const { taskDir } = await makeTask(temp)
      const callbacks = {
        killed: [] as string[],
        cleaned: [] as string[],
        unregistered: [] as string[],
      }
      const session = new QueryEngineOracleSkillAuthorSession({
        cwd: temp,
        taskDir,
        authorWorkspaceDir: join(temp, 'bundle', '.authoring', 'workspace'),
        systemPrompt: 'author',
        jsonSchema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
        maxTurns: 1,
      })
      const stateAccess = session as unknown as {
        getAppState: () => { tasks?: Record<string, unknown> }
        setAppState: (updater: (prev: { tasks?: Record<string, unknown> }) => { tasks?: Record<string, unknown> }) => void
      }
      stateAccess.setAppState(prev => ({
        ...prev,
        tasks: {
          liveAuthorShell: makeShellTask('liveAuthorShell', callbacks),
        },
      }))

      await session.dispose()

      expect(callbacks.killed).toEqual(['liveAuthorShell'])
      expect(stateAccess.getAppState().tasks?.liveAuthorShell).toMatchObject({
        status: 'killed',
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('uses an injected author session to generate the default query-engine bundle', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-query-generate-'))
    try {
      const { tasksDir } = await makeTask(temp)
      const prompts: string[] = []
      const fakeSession: OracleSkillAuthorSession = {
        async submit(prompt, options) {
          prompts.push(prompt)
          const event = { type: 'assistant_text', text: 'drafting oracle skill' }
          await options?.onEvent?.(event)
          return { draft: demoDraft(), events: [event] }
        },
      }

      const result = await generateOracleSkillBundle({
        taskId: 'demo_task',
        tasksDir,
        outDir: join(temp, 'bundle'),
        authorSessionFactory: async () => fakeSession,
      })

      expect(result.mode).toBe('query-engine')
      expect(prompts).toHaveLength(1)
      expect((await validateOracleSkillBundle(result.bundleDir)).ok).toBe(true)
      expect(result.trajectoryPaths?.clean).toBeTruthy()
      expect(result.trajectoryPaths?.raw).toBeTruthy()
      expect(result.trajectoryPaths?.events).toBeTruthy()
      expect(await readFile(result.trajectoryPaths!.clean, 'utf8')).toContain('drafting oracle skill')
      expect(await readFile(result.trajectoryPaths!.raw, 'utf8')).toContain('assistant_text')
      expect(await readFile(result.trajectoryPaths!.events, 'utf8')).toContain('agent_event')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  test('template mode remains available as a deterministic fallback', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'oracle-template-generate-'))
    try {
      const { tasksDir } = await makeTask(temp)
      const result = await generateOracleSkillBundle({
        taskId: 'demo_task',
        tasksDir,
        outDir: join(temp, 'bundle'),
        mode: 'template',
      })
      expect(result.mode).toBe('template')
      expect((await validateOracleSkillBundle(result.bundleDir)).ok).toBe(true)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
