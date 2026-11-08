import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { build } from 'esbuild'
import { clientSourceManifest, readClientSourceInputs } from '../../../../packaging/session-engine/client-source.mjs'
import { selectMobileClientSource } from '../../../../packaging/session-engine/client-selection.mjs'

const root = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const producerRequire = createRequire(resolve(root, '../../packaging/session-engine/package.json'))
const hash = value => createHash('sha256').update(value).digest('hex')

test('normal browser consumer resolves the complete client entry without Node, engine or native imports', async () => {
  const result = await build({ absWorkingDir: root, stdin: {
    contents: "export * from '@nessie/t3-session-source/client'", resolveDir: root,
  }, bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true })
  assert.ok(result.outputFiles[0].contents.length > 0)
  const inputs = Object.keys(result.metafile.inputs)
  assert.equal(inputs.some(path =>
    /(?:engine\.js|@effect\/platform-node|react-native|apps\/server\/)/u.test(path)), false)
  assert.equal(Object.values(result.metafile.outputs)
    .some(output => output.imports.some(input => input.external)), false)
})

test('normal client declaration entry supports strict Bundler and NodeNext consumers', () => {
  const browser = spawnSync(process.execPath, ['--max-old-space-size=5120', require.resolve('typescript/bin/tsc'),
    '--project', resolve(import.meta.dirname, 'tsconfig.browser.json')],
  { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(browser.error, undefined)
  assert.equal(browser.status, 0, `${browser.stdout}\n${browser.stderr}`)
  for (const [module, resolution] of [['ESNext', 'Bundler'], ['NodeNext', 'NodeNext']]) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=5120', require.resolve('typescript/bin/tsc'),
      '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
      '--noUnusedLocals', '--noUnusedParameters', '--target', 'ES2022', '--module', module,
      '--moduleResolution', resolution, '--allowImportingTsExtensions', '--resolveJsonModule',
      '--types', 'node', resolve(import.meta.dirname, 'consumer.mts')],
    { cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  }
})

test('normal producer preserves selected original statements and records their complete provenance', async () => {
  const ts = producerRequire('typescript')
  const original = await readClientSourceInputs({ identity: {
    commit: clientSourceManifest.sourceCommit, tree: clientSourceManifest.sourceTree },
    files: [], read: () => { throw new Error('Unregistered original source') } }, resolve(root, '.artifacts/source/upstream.git'))
  const selected = selectMobileClientSource(ts, original, clientSourceManifest)
  const provenance = JSON.parse(await readFile(resolve(root, 'dist/engine.provenance.json'), 'utf8'))
  assert.deepEqual(provenance.mobileClientSelection, selected.records)
  for (const record of selected.records) {
    const source = original.read(record.path).toString('utf8')
    const output = selected.snapshot.read(record.path).toString('utf8')
    for (const { start, end, sha256 } of record.originalRanges) {
      const statement = source.slice(start, end)
      assert.equal(hash(statement), sha256)
      assert.ok(output.includes(statement), `Changed original statement: ${record.path}:${start}`)
    }
    assert.equal(hash(output), record.selectedSha256)
  }
  assert.ok(provenance.typecheck.declarations.entries.includes('client.d.ts'))
  assert.equal(provenance.clientGraph.inputs.some(path => path.includes('apps/server/')), false)
})

test('mobile selection rejects drift, unregistered imports and selected native dependencies', () => {
  const ts = producerRequire('typescript')
  const path = 'apps/mobile/src/fixture.ts'
  const run = (source, digest = hash(source)) => selectMobileClientSource(ts, {
    identity: {}, files: [path], read: () => Buffer.from(source),
  }, { files: { [path]: digest }, entries: { [path]: ['selected'] } })
  assert.throws(() => run('export const selected = 1', 'changed'), /SOURCE_HASH_MISMATCH/u)
  assert.throws(() => run('import { x } from "./missing"; export const selected = x'), /SOURCE_UNREGISTERED/u)
  assert.throws(() => run('import { x } from "react-native"; export const selected = x'), /EXTERNAL_REFUSED/u)
  assert.throws(() => run('export const selected = () => import("react-native")'), /DYNAMIC_IMPORT_REFUSED/u)
  assert.throws(() => run('export type selected = import("react-native").View'), /IMPORT_TYPE_REFUSED/u)
  const kept = run('import { x } from "react-native"; export const unused = x; export const selected = 42')
  assert.equal(kept.snapshot.read(path).includes(Buffer.from('react-native')), false)
})
