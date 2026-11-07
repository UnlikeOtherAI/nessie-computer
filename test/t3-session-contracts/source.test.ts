import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import ts from 'typescript'
import { readSessionEngineSnapshot, sessionEngineSourcePlugin, sessionContractsAliasPlugin,
  T3_CONTRACTS_SOURCE_ENTRY } from '../../packages/t3-session-source/input.mjs'

const packageRoot = resolve(import.meta.dirname, '../../packages/t3-session-source')
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

test('strict consumers resolve original Type and Encoded relations through published exports', async () => {
  const require = createRequire(resolve(packageRoot, 'package.json'))
  const effectRoot = dirname(require.resolve('effect/package.json'))
  // Use the protocol package's actual dependency links and self-reference exports.
  const fixture = resolve(packageRoot, '../protocol/.artifacts/type-consumer/consumer.mts')
  await mkdir(dirname(fixture), { recursive: true })
  await writeFile(fixture, await readFile(resolve(import.meta.dirname, 'consumer.fixture.ts')))
  for (const moduleResolution of [ts.ModuleResolutionKind.NodeNext, ts.ModuleResolutionKind.Bundler]) {
    const program = ts.createProgram([fixture], {
      moduleResolution, module: moduleResolution === ts.ModuleResolutionKind.NodeNext
        ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023, strict: true, noEmit: true,
      exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      paths: { effect: [resolve(effectRoot, 'dist/index.d.ts')], 'effect/*': [resolve(effectRoot, 'dist/*.d.ts')] },
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: x => x, getCurrentDirectory: () => packageRoot, getNewLine: () => '\n',
    }))
    assert.ok(program.getSourceFiles().some(file => file.fileName.endsWith('/source/rpc.ts')))
    const effectFiles = program.getSourceFiles().filter(file => /[/\\]effect[/\\]dist[/\\]/u.test(file.fileName))
    assert.ok(effectFiles.length > 0)
    assert.ok(effectFiles.every(file => file.fileName.replaceAll('\\', '/').startsWith(effectRoot.replaceAll('\\', '/'))))
  }
})

test('generated provenance binds checked original source, module and declaration dependency files', async () => {
  const provenance = JSON.parse(await readFile(resolve(packageRoot, 'dist/provenance.json'), 'utf8'))
  assert.equal(provenance.source.commit, '25bf84ab07f53f141c20239c63e383823a9d5ea0')
  assert.equal(provenance.source.archiveSha256, '6ec4dc60aa5b92dabbf69c55b408b1db87d77d0a132cbc1fbca61daa0b4f7096')
  assert.equal(provenance.effect, '4.1.2')
  assert.equal(provenance.files.length, 78)
  assert.equal(hash(await readFile(resolve(packageRoot, 'dist/contracts.js'))), provenance.moduleSha256)
  for (const file of provenance.declarations) assert.equal(
    hash(await readFile(resolve(packageRoot, 'dist', file.path))), file.sha256)
  assert.equal(hash(JSON.stringify(provenance.files)), provenance.selectionSha256)
  assert.equal(hash(JSON.stringify(provenance.declarations)), provenance.declarationsSha256)
  for (const file of provenance.modules) assert.equal(hash(await readFile(resolve(packageRoot, 'dist', file.path))), file.sha256)
  assert.equal(hash(JSON.stringify(provenance.modules)), provenance.modulesSha256)
})

test('final co-build alias shares original schema identity in one source namespace', async () => {
  const provenance = JSON.parse(await readFile(resolve(packageRoot, 'dist/provenance.json'), 'utf8'))
  const archive = resolve(packageRoot, '.artifacts/source', provenance.source.archiveSha256, 'source.tar')
  const snapshot = await readSessionEngineSnapshot(archive)
  const directory = resolve(packageRoot, '.artifacts/co-build-proof')
  await mkdir(directory, { recursive: true })
  const output = resolve(directory, 'contracts.mjs')
  const bundle = await build({
    absWorkingDir: packageRoot, stdin: { contents: `
      import { ThreadId as first } from '@nessie/t3-session-source/contracts';
      import { ThreadId as second } from '${T3_CONTRACTS_SOURCE_ENTRY}';
      export const shared = first === second;
    `, resolveDir: packageRoot, loader: 'ts' },
    outfile: output, bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm',
    plugins: [sessionContractsAliasPlugin({ dependencyDirectory: packageRoot }), sessionEngineSourcePlugin({
      snapshot, dependencyDirectory: packageRoot, dependencies: ['effect'],
    })],
  })
  await writeFile(output, bundle.outputFiles[0]!.contents)
  assert.equal((await import(pathToFileURL(output).href)).shared, true)
  assert.ok(Object.keys(bundle.metafile.inputs).every(file => file.startsWith('nessie-t3-source:')
    || file === '<stdin>' || file.replaceAll('\\', '/').includes('node_modules/effect/')))
  assert.ok(Object.values(bundle.metafile.outputs).every(file => file.imports.every(item => !item.external)))
})
