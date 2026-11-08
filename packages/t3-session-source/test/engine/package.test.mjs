import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { preparePackageHistoryFixture } from './history-fixture.mjs'
import { assertLibraryAuthoredInputs } from '../../../../packaging/session-engine/library.mjs'
import { typecheckSessionState } from '../../../../packaging/session-engine/typecheck.mjs'

const root = resolve(import.meta.dirname, '../..')
const executor = resolve(root, '../..')
const require = createRequire(import.meta.url)
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.stdout) process.stdout.write(result.stdout)
}

test('normal library import shares original codecs, Context tags and the consumer Effect root without starting work', () => {
  run([resolve(import.meta.dirname, 'runtime.mjs')])
})

test('normal engine composes original request refusals, resource cleanup and opaque host references', () => {
  run([resolve(import.meta.dirname, 'composition.mjs')])
})

test('browser contracts remain independently bundleable through their normal package entries', async () => {
  const result = await build({ absWorkingDir: root, stdin: { contents:
    `export { ThreadId } from '@nessie/t3-session-source/contracts';
     export { ServerSettingsPatch } from '@nessie/t3-session-source/contracts/settings';`,
  resolveDir: root }, bundle: true, format: 'esm', platform: 'browser',
  external: ['effect', 'effect/*'], write: false, metafile: true })
  assert.equal(Object.keys(result.metafile.inputs).some(path => path.endsWith('/engine.js')), false)
})

test('authored admission checks erased type-only imports in the real TypeScript program', async () => {
  const base = resolve(root, '.artifacts/type-admission')
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(resolve(base, 'run-'))
  const entry = resolve(directory, 'entry.ts')
  const hidden = resolve(directory, 'hidden.d.ts')
  await writeFile(entry, "import type { Hidden } from './hidden.js'; export type Visible = Hidden\n")
  await writeFile(hidden, 'export interface Hidden { readonly exact: string }\n')
  const path = file => relative(executor, file).replaceAll('\\', '/')
  const registration = { entryPoint: 'packaging/session-engine/core/Engine.ts', authoredInputs: [path(entry)] }
  const options = { assertAuthoredInputs: paths => assertLibraryAuthoredInputs(paths, registration) }
  await assert.rejects(typecheckSessionState({ files: [] }, entry, options),
    /SESSION_ENGINE_LIBRARY_AUTHORED_INPUT_REFUSED/u)
  registration.authoredInputs.push(path(hidden))
  const checked = await typecheckSessionState({ files: [] }, entry, options)
  assert.deepEqual(Object.keys(checked.authoredInputs).sort(), [path(entry), path(hidden)].sort())
})

test('normal package exports retain strict NodeNext and Bundler types and original required host ports', () => {
  for (const [module, resolution] of [['ESNext', 'Bundler'], ['NodeNext', 'NodeNext']]) {
    run(['--max-old-space-size=5120', require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes', '--noUnusedLocals', '--noUnusedParameters',
      '--target', 'ES2022', '--module', module, '--moduleResolution', resolution,
      '--allowImportingTsExtensions', '--resolveJsonModule', '--types', 'node', resolve(import.meta.dirname, 'consumer.mts')])
  }
})

test('normal engine package runs original SQLite migrations, history, replay, pruning and reopen assertions', async () => {
  const base = resolve(root, '.artifacts/package-history')
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(resolve(base, 'run-'))
  await preparePackageHistoryFixture(directory, executor)
  await writeFile(resolve(directory, 'run.mjs'),
    `import { runSessionHistoryProof } from './history.mjs';\nconsole.log(JSON.stringify(await runSessionHistoryProof(${JSON.stringify(directory)})));\n`)
  run([resolve(directory, 'run.mjs')])
})

test('runtime/type/notices provenance binds generated package files and excludes embedded Effect and synthetic entries', async () => {
  const dist = resolve(root, 'dist')
  const provenance = JSON.parse(await readFile(resolve(dist, 'engine.provenance.json'), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(provenance.kind, 'session-engine-package')
  assert.equal(provenance.qualification.distributableLibrary, true)
  assert.equal(provenance.qualification.syntheticProofs, false)
  assert.equal(provenance.typecheck.libraryChecks, true)
  assert.equal(provenance.sourceIdentity.orderedPatchesSha256,
    '8708c678a9a5f524e5cca8f02271b3f7318d3de957c68143eebbc0bef883afe8')
  assert.equal(Object.keys(provenance.dependencyInputs).some(path => path.includes('/effect/')), false)
  for (const file of provenance.modules) {
    const bytes = await readFile(resolve(dist, file.path))
    assert.equal(hash(bytes), file.sha256)
    assert.equal(bytes.includes(Buffer.from('layerLegacyV1ThreadImporterNoop')), false)
  }
  for (const [file, digest] of Object.entries(provenance.typecheck.declarations.files)) {
    assert.ok(file.endsWith('.d.ts'), `Engine implementation escaped into consumer types: ${file}`)
    assert.equal(hash(await readFile(resolve(dist, 'engine-types', file))), digest)
  }
  for (const [file, digest] of Object.entries(provenance.sharedContractTypes)) {
    assert.equal(hash(await readFile(resolve(dist, file))), digest)
  }
  assert.equal(hash(await readFile(resolve(dist, 'engine.licenses.json'))), provenance.licensesSha256)
  const notices = JSON.parse(await readFile(resolve(dist, 'engine.licenses.json'), 'utf8'))
  assert.ok(notices.upstream.license.includes('MIT License'))
  assert.ok(notices.dependencies.some(item => item.name === 'effect' && item.version === '4.1.2'))
  assert.throws(() => assertLibraryAuthoredInputs(['src/t3-session/import/unregistered.ts'], provenance.registration))
  assert.throws(() => assertLibraryAuthoredInputs([], { ...provenance.registration,
    authoredInputs: ['../sibling.ts'] }))
})
