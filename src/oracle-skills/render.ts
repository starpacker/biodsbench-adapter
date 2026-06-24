import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { dirname, extname, join, parse, relative, resolve } from 'path'
import {
  assertNoForbiddenVariantText,
  assertOracleSkillBundleValid,
  assertSafeRelativeAssetPath,
  resolveEnabledOperationIdsFromDropOps,
  resolveEnabledOperations,
} from './manifest.js'
import type {
  DisabledOperation,
  OracleOperation,
  OracleSkillManifest,
  RenderOracleSkillVariantInput,
  RenderOracleSkillVariantResult,
  VariantManifest,
} from './types.js'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function removeOperationBlock(markdown: string, anchor: string): string {
  const pattern = new RegExp(
    `\\n?<!--\\s*ORACLE_OP_START\\s+${escapeRegExp(anchor)}\\s*-->[\\s\\S]*?<!--\\s*ORACLE_OP_END\\s+${escapeRegExp(anchor)}\\s*-->\\n?`,
    'g',
  )
  return markdown.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n')
}

function stripInternalOperationMarkers(markdown: string): string {
  return markdown
    .replace(/^<!--\s*ORACLE_OP_(?:START|END)\s+[^>]+-->\s*$/gm, '')
    .replace(/^#{1,6}\s+op_[A-Za-z0-9_-]+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

function isInside(path: string, parent: string): boolean {
  const child = resolve(path)
  const base = resolve(parent)
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base
  return normalizedChild === normalizedBase || normalizedChild.startsWith(`${normalizedBase}${process.platform === 'win32' ? '\\' : '/'}`)
}

function assertSafeOutputRoot(outDir: string, bundleDir: string): void {
  const resolved = resolve(outDir)
  if (resolved === parse(resolved).root) {
    throw new Error(`Refusing to render oracle skill variant at filesystem root: ${outDir}`)
  }
  if (isInside(bundleDir, outDir)) {
    throw new Error('Refusing to render oracle skill variant over its source bundle')
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function aliasAssetPaths(input: {
  resources: string[]
  scripts: string[]
}): Map<string, string> {
  const aliases = new Map<string, string>()
  input.resources.forEach((asset, index) => {
    aliases.set(asset, `resources/resource_${String(index + 1).padStart(3, '0')}${extname(asset)}`)
  })
  input.scripts.forEach((asset, index) => {
    aliases.set(asset, `scripts/script_${String(index + 1).padStart(3, '0')}${extname(asset)}`)
  })
  return aliases
}

function replaceAssetReferences(content: string, assetAliases: Map<string, string>): string {
  let updated = content
  for (const [source, alias] of assetAliases) {
    updated = updated.replace(new RegExp(escapeRegExp(source), 'g'), alias)
    updated = updated.replace(new RegExp(escapeRegExp(source.replace(/\//g, '\\')), 'g'), alias)
  }
  return updated
}

async function copyOperationAssets(input: {
  skillRoot: string
  outSkillRoot: string
  assets: string[]
  assetAliases: Map<string, string>
}): Promise<string[]> {
  const copied: string[] = []
  const assets = uniqueSorted(input.assets)
  for (const asset of assets) {
    assertSafeRelativeAssetPath(asset)
    const source = join(input.skillRoot, asset)
    const alias = input.assetAliases.get(asset)
    if (!alias) throw new Error(`Missing solver-facing asset alias for ${asset}`)
    assertSafeRelativeAssetPath(alias)
    const destination = join(input.outSkillRoot, alias)
    await mkdir(dirname(destination), { recursive: true })
    const content = await readFile(source, 'utf8')
    await writeFile(destination, replaceAssetReferences(content, input.assetAliases), 'utf8')
    copied.push(alias)
  }
  return copied
}

function assertNoSolverFacingOracleMetadata(input: {
  path: string
  content: string
  operationIds: string[]
}): void {
  assertNoForbiddenVariantText(input)
  const leaks = [
    { token: 'ORACLE_OP_START/END', pattern: /ORACLE_OP_(?:START|END)/i },
    { token: 'drop marker', pattern: /\bdrop[_-]/i },
    { token: 'enabled_ops', pattern: /\benabled_ops\b/i },
    { token: 'disabled_ops', pattern: /\bdisabled_ops\b/i },
    { token: 'disabled_by_request', pattern: /\bdisabled_by_request\b/i },
    { token: 'ablatable', pattern: /\bablatable\b/i },
    { token: 'pipeline summary', pattern: /^\s*(?:data flow|pipeline)\s*:/im },
    { token: 'operation id', pattern: /\bop_[0-9]{3}[A-Za-z0-9_-]*\b/i },
  ]
  const leak = leaks.find(item => item.pattern.test(input.content))
  if (leak) {
    throw new Error(`Rendered oracle skill contains solver-facing operation metadata "${leak.token}" in ${input.path}`)
  }
  const knownId = input.operationIds.find(id => input.content.includes(id))
  if (knownId) {
    throw new Error(`Rendered oracle skill contains operation id "${knownId}" in ${input.path}`)
  }
}

async function scanRenderedText(root: string, operationIds: string[], current = root): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) {
      await scanRenderedText(root, operationIds, absolute)
      continue
    }
    if (!entry.isFile()) continue
    const relativePath = relative(root, absolute).replace(/\\/g, '/')
    assertNoSolverFacingOracleMetadata({
      path: `${relativePath} path`,
      content: relativePath,
      operationIds,
    })
    const content = await readFile(absolute, 'utf8')
    assertNoSolverFacingOracleMetadata({ path: relativePath, content, operationIds })
  }
}

function evalCommand(outDir: string, skillName: string): string {
  return `--enable-skills --skills-dir ${resolve(outDir, 'skills').replace(/\\/g, '/')} --skill-name ${skillName}\n`
}

function defaultVariantManifestPath(outDir: string): string {
  return join(dirname(outDir), 'metadata', 'variants', `${parse(outDir).base}.json`)
}

function evalCommandPathForManifest(variantManifestPath: string): string {
  const parsed = parse(variantManifestPath)
  return join(parsed.dir, `${parsed.name}.eval_command.txt`)
}

type ResolvedVariantOperations = {
  enabledOps: OracleOperation[]
  disabledOps: DisabledOperation[]
}

function resolveVariantOperations(
  manifest: OracleSkillManifest,
  input: RenderOracleSkillVariantInput,
): ResolvedVariantOperations {
  if (input.enabledOperationIds && input.dropOperationIds) {
    throw new Error('enabledOperationIds and dropOperationIds are mutually exclusive')
  }
  if ((input as { unsafeAllowDangling?: unknown }).unsafeAllowDangling) {
    throw new Error('unsafeAllowDangling is no longer supported; dropOperationIds are rendered exactly')
  }

  if (input.dropOperationIds) {
    const enabledOperationIds = resolveEnabledOperationIdsFromDropOps(
      manifest,
      input.dropOperationIds,
    )
    return resolveEnabledOperations(manifest, enabledOperationIds)
  }
  return resolveEnabledOperations(manifest, input.enabledOperationIds)
}

export async function renderOracleSkillVariant(
  input: RenderOracleSkillVariantInput,
): Promise<RenderOracleSkillVariantResult> {
  assertSafeOutputRoot(input.outDir, input.bundleDir)
  const manifest = await assertOracleSkillBundleValid(input.bundleDir)
  const { enabledOps, disabledOps } = resolveVariantOperations(manifest, input)
  const skillRoot = join(input.bundleDir, 'skills', manifest.skill_name)
  const outSkillRoot = join(input.outDir, 'skills', manifest.skill_name)
  const sourceSkillMd = join(skillRoot, 'SKILL.md')
  let markdown = await readFile(sourceSkillMd, 'utf8')
  for (const disabled of disabledOps) {
    const op = manifest.operations.find(item => item.id === disabled.id)
    if (op) markdown = removeOperationBlock(markdown, op.skill_md_anchor)
  }
  const resources = uniqueSorted(enabledOps.flatMap(op => op.resources))
  const scripts = uniqueSorted(enabledOps.flatMap(op => op.scripts))
  const assetAliases = aliasAssetPaths({ resources, scripts })
  markdown = stripInternalOperationMarkers(replaceAssetReferences(markdown, assetAliases))

  await rm(input.outDir, { recursive: true, force: true })
  await mkdir(outSkillRoot, { recursive: true })
  await writeFile(join(outSkillRoot, 'SKILL.md'), markdown, 'utf8')
  const copiedResources = await copyOperationAssets({
    skillRoot,
    outSkillRoot,
    assets: resources,
    assetAliases,
  })
  const copiedScripts = await copyOperationAssets({
    skillRoot,
    outSkillRoot,
    assets: scripts,
    assetAliases,
  })

  const variant: VariantManifest = {
    schema_version: 1,
    source_bundle: resolve(input.bundleDir),
    skill_name: manifest.skill_name,
    enabled_ops: enabledOps.map(op => op.id),
    disabled_ops: disabledOps,
    copied_resources: copiedResources,
    copied_scripts: copiedScripts,
    generated_at: new Date().toISOString(),
  }
  const variantManifestPath = input.variantManifestPath ?? defaultVariantManifestPath(input.outDir)
  await mkdir(dirname(variantManifestPath), { recursive: true })
  await writeFile(variantManifestPath, `${JSON.stringify(variant, null, 2)}\n`, 'utf8')
  await writeFile(evalCommandPathForManifest(variantManifestPath), evalCommand(input.outDir, manifest.skill_name), 'utf8')
  await scanRenderedText(input.outDir, manifest.operations.map(op => op.id))
  return variant
}
