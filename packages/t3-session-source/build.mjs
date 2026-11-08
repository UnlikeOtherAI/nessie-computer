// Build-time dependency extraction. Never imports or executes the T3 server.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { prepareSessionEngineSource, T3_SESSION_ENGINE_SOURCE } from '../../packaging/session-engine/source.mjs'
import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'
import { createSessionEngineSourceResolver } from '../../packaging/session-engine/resolver.mjs'
import { buildSessionPackage, prepareLibrarySnapshot } from '../../packaging/session-engine/library.mjs'
import { sessionContractsAliasPlugin } from './input.mjs'
import { extractT3RawHttp } from './routes.mjs'
import { ensurePinnedSourceObject } from './cache.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, '.artifacts/package-builds', randomUUID())
const cache = resolve(root, '.artifacts/source')
const source = resolve(cache, T3_SESSION_ENGINE_SOURCE.archiveSha256, 'capsule')
const archive = resolve(cache, T3_SESSION_ENGINE_SOURCE.archiveSha256, 'source.tar')
const repository = resolve(cache, 'upstream.git')
const contracts = resolve(source, 'packages/contracts/src')
const digest = value => createHash('sha256').update(value).digest('hex')
await mkdir(cache, { recursive: true })
await ensurePinnedSourceObject({ repository, upstream: T3_SESSION_ENGINE_SOURCE.repository,
  commit: T3_SESSION_ENGINE_SOURCE.commit })
await prepareSessionEngineSource({ sourceRepository: repository, archivePath: archive })
const original = await readSessionEngineSnapshot(archive)
const prepared = await prepareLibrarySnapshot(original)
const { snapshot } = prepared
const resolver = createSessionEngineSourceResolver(snapshot)
// The protocol ledger binds the original application's declarations, not extracted server line shifts.
const rawHttpRoutes = extractT3RawHttp(original)

// TypeScript's parser follows imports, exports and import types; comments and
// strings that merely resemble imports cannot widen the source selection.
const files = new Map()
const visit = async file => {
  if (files.has(file)) return
  if (!file.startsWith(`${contracts}/`) && !file.startsWith(`${contracts}\\`)) throw Error('CONTRACT_PATH_ESCAPE')
  const sourcePath = relative(source, file).replaceAll('\\', '/')
  const bytes = resolver.load(sourcePath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  files.set(file, digest(original.read(sourcePath)))
  const tree = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true)
  const dependencies = new Set()
  const walk = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      dependencies.add(node.moduleSpecifier.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) dependencies.add(node.argument.literal.text)
    ts.forEachChild(node, walk)
  }
  walk(tree)
  for (const name of dependencies) {
    const selected = resolver.resolve(name, sourcePath)
    if (selected.kind === 'source') await visit(resolve(source, selected.path))
    else if (selected.kind !== 'dependency' || name !== 'effect' && !name.startsWith('effect/')) {
      throw Error(`CONTRACT_EXTERNAL_REFUSED:${name}`)
    }
  }
}
await visit(resolve(contracts, 'index.ts'))
if (files.size !== 78) throw Error(`CONTRACT_SELECTION_CHANGED:${files.size}`)
const selection = [...files].map(([file, sha256]) => ({ path: relative(source, file).replaceAll('\\', '/'), sha256 }))
  .sort((a, b) => a.path.localeCompare(b.path, 'en'))
const expected = JSON.parse(await readFile(resolve(root, 'selection.json'), 'utf8'))
if (JSON.stringify(selection) !== JSON.stringify(expected)) throw Error('CONTRACT_SELECTION_DIGEST_MISMATCH')
if (!/^\s*effect: 4\.1\.2\s*$/m.test(snapshot.read('pnpm-workspace.yaml').toString('utf8'))) {
  throw Error('CONTRACT_EFFECT_VERSION_CHANGED')
}
// Engine.ts exports the entire contract namespace. One strict, library-checking
// program below checks both graphs; retaining a second contract program doubled memory.
if (process.argv.includes('--check')) {
  await buildSessionPackage({ original, prepared, outputDirectory: output,
    contractsAliasPlugin: sessionContractsAliasPlugin, check: true })
  process.exit(0)
}
await mkdir(output, { recursive: true })
// Upstream exports source types. Preserve that authority: expanding its huge
// inferred RPC/stream types into .d.ts exceeds TS7056. This declaration entry
// refers to the checked source with module-suffix changes, never a DTO rewrite.
await mkdir(resolve(output, 'types'), { recursive: true })
for (const entry of ['index', 'settings', 'relay']) await writeFile(resolve(output, `types/${entry}.d.ts`),
  `/// <reference lib="es2023.array" />\nexport * from "../source/${entry}.js";\n`)
await writeFile(resolve(output, 'LICENSE'), snapshot.read('LICENSE'))
await writeFile(resolve(output, 'FIRST_PARTY_LICENSE'), await readFile(resolve(root, '../../LICENSE')))
await writeFile(resolve(output, 'routes.json'), `${JSON.stringify(rawHttpRoutes, null, 2)}\n`)
const declarations = []
for (const { path } of selection) {
  const name = path.replace('packages/contracts/src/', '')
  const original = await readFile(resolve(source, path), 'utf8')
  // Declaration consumers use NodeNext without importing TypeScript at runtime.
  // Only relative module suffixes change; schema expressions remain original.
  const bytes = original.replace(/(from\s+["']\.[^"']*)\.ts(["'])/gu, '$1.js$2')
  await mkdir(dirname(resolve(output, 'source', name)), { recursive: true })
  await writeFile(resolve(output, 'source', name), bytes)
  declarations.push({ path: `source/${name}`, sha256: digest(bytes) })
}
for (const entry of ['index', 'settings', 'relay']) declarations.push({ path: `types/${entry}.d.ts`,
  sha256: digest(await readFile(resolve(output, `types/${entry}.d.ts`))) })
const { result, provenance: engine } = await buildSessionPackage({ original, prepared,
  outputDirectory: output, contractsAliasPlugin: sessionContractsAliasPlugin })
const modules = []
for (const path of Object.keys(result.metafile.outputs).sort()) modules.push({
  path: relative(output, resolve(root, '../../packaging/session-engine', path)).replaceAll('\\', '/'),
  sha256: digest(await readFile(resolve(root, '../../packaging/session-engine', path))),
})
// The build-helper API also works in a packed consumer; it never loads the runtime.
await mkdir(resolve(output, 'build'), { recursive: true })
const buildHelperFiles = []
for (const file of ['input.mjs', 'resolver.mjs', 'snapshot.mjs', 'source.mjs', 'source-lock.json']) {
  const original = await readFile(file === 'input.mjs' ? resolve(root, file)
    : resolve(root, '../../packaging/session-engine', file), 'utf8')
  const bytes = file === 'input.mjs' ? original.replaceAll('../../packaging/session-engine/', './') : original
  await writeFile(resolve(output, 'build', file), bytes)
  buildHelperFiles.push({ path: `build/${file}`, sha256: digest(bytes) })
}
const provenance = {
  format: 1, source: T3_SESSION_ENGINE_SOURCE, effect: '4.1.2', patches: [{
    kind: 'declaration-module-suffix', algorithm: 'relative from .ts to .js',
    sha256: digest(JSON.stringify(declarations)),
  }],
  sourceIdentity: snapshot.identity,
  engineModulesSha256: engine.modulesSha256,
  buildHelperFiles,
  selectionSha256: digest(JSON.stringify(selection)), files: selection,
  moduleSha256: digest(await readFile(resolve(output, 'contracts.js'))),
  modules, modulesSha256: digest(JSON.stringify(modules)),
  sourceLockSha256: digest(await readFile(new URL('../../packaging/session-engine/source-lock.json', import.meta.url))),
  dependencyManifestSha256: digest(await readFile(resolve(root, 'package.json'))),
  dependencyLockSha256: digest(await readFile(new URL('../../pnpm-lock.yaml', import.meta.url))),
  declarationsSha256: digest(JSON.stringify(declarations)), declarations,
  adapterSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  coBuildAdapterSha256: digest(await readFile(resolve(root, 'input.mjs'))),
  cacheAdapterSha256: digest(await readFile(resolve(root, 'cache.mjs'))),
  rawHttpRoutesSha256: digest(JSON.stringify(rawHttpRoutes)),
  rawHttpSource: 'original-committed-capsule',
  routeAdapterSha256: digest(await readFile(resolve(root, 'routes.mjs'))),
}
await writeFile(resolve(output, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
process.stdout.write(`Original T3 contracts: ${files.size} files; Effect external; ${provenance.moduleSha256}\n`)

// Publish a complete generation after checks and metadata writes. Preserve previous outputs.
const dist = resolve(root, 'dist')
const previous = resolve(root, '.artifacts/package-builds', `previous-${randomUUID()}`)
let hadPrevious = false
try { await rename(dist, previous); hadPrevious = true } catch (error) { if (error.code !== 'ENOENT') throw error }
try { await rename(output, dist) } catch (error) { if (hadPrevious) await rename(previous, dist); throw error }
