// Build-time dependency extraction. Never imports or executes the T3 server.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'
import { prepareSessionEngineSource, T3_SESSION_ENGINE_SOURCE } from '../../packaging/session-engine/source.mjs'
import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'
import { createSessionEngineSourceResolver, sessionEngineSourcePlugin } from '../../packaging/session-engine/resolver.mjs'
import { extractT3RawHttp } from './routes.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const cache = resolve(root, '.artifacts/source')
const source = resolve(cache, T3_SESSION_ENGINE_SOURCE.archiveSha256, 'capsule')
const archive = resolve(cache, T3_SESSION_ENGINE_SOURCE.archiveSha256, 'source.tar')
const repository = resolve(cache, 'upstream.git')
const contracts = resolve(source, 'packages/contracts/src')
const digest = value => createHash('sha256').update(value).digest('hex')
const run = (command, args) => execFileSync(command, args, {
  cwd: root, stdio: 'pipe', windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024 * 1024,
})
const exists = path => stat(path).then(() => true, () => false)
await mkdir(cache, { recursive: true })
if (!await exists(repository)) {
  run('git', ['init', '--bare', repository])
  run('git', ['--git-dir', repository, 'fetch', '--depth=1', T3_SESSION_ENGINE_SOURCE.repository,
    T3_SESSION_ENGINE_SOURCE.commit])
}
await prepareSessionEngineSource({ sourceRepository: repository, archivePath: archive })
const snapshot = await readSessionEngineSnapshot(archive)
const resolver = createSessionEngineSourceResolver(snapshot)
const rawHttpRoutes = extractT3RawHttp(snapshot)

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
  files.set(file, digest(bytes))
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
// Resolve Effect through this package, for both original source and consumers.
// It is external to emitted JS: the engine co-build must use this same root.
const require = createRequire(import.meta.url)
const effectRoot = dirname(require.resolve('effect/package.json'))
const options = {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
  allowImportingTsExtensions: true, noEmit: true, noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true, noImplicitOverride: true,
  paths: { effect: [resolve(effectRoot, 'dist/index.d.ts')], 'effect/*': [resolve(effectRoot, 'dist/*.d.ts')] },
}
const program = ts.createProgram([...files.keys()], options)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
  process.exit(1)
}
if (process.argv.includes('--check')) process.exit(0)
await mkdir(resolve(root, 'dist'), { recursive: true })
// Upstream exports source types. Preserve that authority: expanding its huge
// inferred RPC/stream types into .d.ts exceeds TS7056. This declaration entry
// refers to the checked source with module-suffix changes, never a DTO rewrite.
await mkdir(resolve(root, 'dist/types'), { recursive: true })
for (const entry of ['index', 'settings', 'relay']) await writeFile(resolve(root, `dist/types/${entry}.d.ts`),
  `/// <reference lib="es2023.array" />\nexport * from "../source/${entry}.js";\n`)
const result = await build({
  absWorkingDir: root,
  entryPoints: { contracts: 't3-source:packages/contracts/src/index.ts',
    settings: 't3-source:packages/contracts/src/settings.ts', relay: 't3-source:packages/contracts/src/relay.ts' },
  outdir: resolve(root, 'dist'), splitting: true,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['effect', 'effect/*'], legalComments: 'eof', metafile: true, write: true,
  plugins: [sessionEngineSourcePlugin({ snapshot, dependencyDirectory: root, dependencies: ['effect'] })],
})
const emitted = Object.entries(result.metafile.outputs).flatMap(([, value]) => value.imports)
if (emitted.some(item => item.external && item.path !== 'effect' && !item.path.startsWith('effect/'))) {
  throw Error('CONTRACT_BUNDLE_EXTERNAL_CHANGED')
}
await writeFile(resolve(root, 'dist/LICENSE'), snapshot.read('LICENSE'))
await writeFile(resolve(root, 'dist/routes.json'), `${JSON.stringify(rawHttpRoutes, null, 2)}\n`)
const declarations = []
for (const { path } of selection) {
  const name = path.replace('packages/contracts/src/', '')
  const original = await readFile(resolve(source, path), 'utf8')
  // Declaration consumers use NodeNext without importing TypeScript at runtime.
  // Only relative module suffixes change; schema expressions remain original.
  const bytes = original.replace(/(from\s+["']\.[^"']*)\.ts(["'])/gu, '$1.js$2')
  await mkdir(dirname(resolve(root, 'dist/source', name)), { recursive: true })
  await writeFile(resolve(root, 'dist/source', name), bytes)
  declarations.push({ path: `source/${name}`, sha256: digest(bytes) })
}
for (const entry of ['index', 'settings', 'relay']) declarations.push({ path: `types/${entry}.d.ts`,
  sha256: digest(await readFile(resolve(root, `dist/types/${entry}.d.ts`))) })
const modules = []
for (const path of Object.keys(result.metafile.outputs).sort()) modules.push({
  path: relative(resolve(root, 'dist'), resolve(root, path)).replaceAll('\\', '/'),
  sha256: digest(await readFile(resolve(root, path))),
})
const provenance = {
  format: 1, source: T3_SESSION_ENGINE_SOURCE, effect: '4.1.2', patches: [{
    kind: 'declaration-module-suffix', algorithm: 'relative from .ts to .js',
    sha256: digest(JSON.stringify(declarations)),
  }],
  selectionSha256: digest(JSON.stringify(selection)), files: selection,
  moduleSha256: digest(await readFile(resolve(root, 'dist/contracts.js'))),
  modules, modulesSha256: digest(JSON.stringify(modules)),
  sourceLockSha256: digest(await readFile(new URL('../../packaging/session-engine/source-lock.json', import.meta.url))),
  dependencyManifestSha256: digest(await readFile(resolve(root, 'package.json'))),
  dependencyLockSha256: digest(await readFile(new URL('../../pnpm-lock.yaml', import.meta.url))),
  declarationsSha256: digest(JSON.stringify(declarations)), declarations,
  adapterSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  coBuildAdapterSha256: digest(await readFile(resolve(root, 'input.mjs'))),
  rawHttpRoutesSha256: digest(JSON.stringify(rawHttpRoutes)),
  routeAdapterSha256: digest(await readFile(resolve(root, 'routes.mjs'))),
}
await writeFile(resolve(root, 'dist/provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
process.stdout.write(`Original T3 contracts: ${files.size} files; Effect external; ${provenance.moduleSha256}\n`)
