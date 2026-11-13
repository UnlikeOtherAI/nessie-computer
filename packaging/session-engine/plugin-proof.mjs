import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { readSessionEngineSnapshot } from './snapshot.mjs'
import { applySessionEngineBoundaryPatches, composeSessionEnginePatchManifests } from './patches.mjs'
import { sessionEngineSourcePlugin } from './resolver.mjs'

const tools = fileURLToPath(new URL('.', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const commit = process.argv[3] ?? '0f53775b804df5558e5a3be6b8a6d6c6f830f638'
const expectedHash = process.argv[4] ?? '763ec6d19901614479f8a0d710255dd6cae6c58dde971b29a71c2d53296fe1ed'
assert.match(commit, /^[a-f0-9]{40}$/u)
assert.match(expectedHash, /^[a-f0-9]{64}$/u)
assert.equal(process.argv[3] === undefined, process.argv[4] === undefined, 'Supply both committed identity and digest')
const input = execFileSync('git', ['--no-replace-objects', 'show', `${commit}:packages/t3-session-source/input.mjs`], {
  cwd: resolve(tools, '../..'), windowsHide: true,
})
assert.equal(hash(input), expectedHash)
await mkdir(resolve(tools, '.artifacts'), { recursive: true })
const directory = await mkdtemp(resolve(tools, '.artifacts/combined-plugins-'))
const helper = resolve(directory, 'packages/t3-session-source/input.mjs')
await mkdir(dirname(helper), { recursive: true })
await writeFile(helper, input, { flag: 'wx' })
await mkdir(resolve(directory, 'packaging'), { recursive: true })
// Exact committed T01 helper, unedited. Its ordinary relative re-exports reach this producer's real tools.
await symlink(tools, resolve(directory, 'packaging/session-engine'), process.platform === 'win32' ? 'junction' : 'dir')
const t01 = await import(pathToFileURL(helper).href)
assert.equal(t01.T3_CONTRACTS_SOURCE_ENTRY, 't3-source:packages/contracts/src/index.ts')
const original = await readSessionEngineSnapshot(resolve(process.argv[2]))
const file = 'packages/contracts/src/baseSchemas.ts'
const before = original.read(file)
const seam = 'import * as Schema from "effect/Schema";'
assert.equal(before.toString('utf8').split(seam).length, 2)
// Probe-only export of the ACTUAL namespace used by this pinned original module; no service/schema substitution.
const to = `${seam}\nexport { Schema as SchemaFromVirtualOriginal };`
const after = Buffer.from(before.toString('utf8').replace(seam, to))
const probe = Buffer.from(JSON.stringify({ format: 1, sourceCommit: original.identity.commit, patches: [{
  id: 'expose-original-schema-namespace-for-build-qualification', file, from: seam, to,
  beforeSha256: hash(before), afterSha256: hash(after),
}] }))
const combined = composeSessionEnginePatchManifests(original, [{ id: 'plugin-identity-probe', bytes: probe }])
const snapshot = applySessionEngineBoundaryPatches(original, combined)
const entry = resolve(directory, 'entry.mjs')
await writeFile(entry, `import * as FirstPartySchema from 'effect/Schema'
import { SchemaFromVirtualOriginal, ThreadId } from 't3-source:${file}'
import { ThreadId as AliasedThreadId } from '@nessie/t3-session-source/contracts'
if (FirstPartySchema !== SchemaFromVirtualOriginal || ThreadId !== AliasedThreadId) throw Error('EFFECT_INSTANCE_SPLIT')
export const sameSchemaNamespace = FirstPartySchema === SchemaFromVirtualOriginal
export const sameOriginalCodec = ThreadId === AliasedThreadId
`, { flag: 'wx' })
const effectRoot = await realpath(dirname(createRequire(import.meta.url).resolve('effect/package.json')))
const results = []
for (const order of ['contracts-first', 'producer-first']) {
  const producer = sessionEngineSourcePlugin({ snapshot, dependencyDirectory: tools, dependencies: ['effect'] })
  const contracts = t01.sessionContractsAliasPlugin({ dependencyDirectory: tools })
  const output = resolve(directory, `${order}.mjs`)
  const result = await build({ absWorkingDir: tools, entryPoints: [entry], outfile: output,
    bundle: true, format: 'esm', platform: 'node', target: 'node22.16', metafile: true,
    minifyWhitespace: true,
    plugins: order === 'contracts-first' ? [contracts, producer] : [producer, contracts] })
  const effectInputs = Object.keys(result.metafile.inputs).filter(path => path.includes('/effect/dist/'))
  assert.ok(effectInputs.length > 0)
  assert.equal(effectInputs.filter(path => path.endsWith('/effect/dist/Schema.js')).length, 1)
  for (const path of effectInputs) assert.ok((await realpath(resolve(tools, path))).startsWith(effectRoot))
  const qualified = await import(pathToFileURL(output).href)
  assert.equal(qualified.sameSchemaNamespace, true)
  assert.equal(qualified.sameOriginalCodec, true)
  results.push({ order, sameSchemaNamespace: true, sameOriginalCodec: true,
    effectSourceModules: effectInputs.length, bundleSha256: hash(await readFile(output)) })
}
process.stdout.write(`${JSON.stringify({ contractsCommit: commit, contractsHelperSha256: hash(input),
  producerResolverSha256: hash(await readFile(new URL('./resolver.mjs', import.meta.url))),
  probeSourceBeforeSha256: hash(before), probeSourceAfterSha256: hash(after),
  dependencyRoot: 'packaging/session-engine', selectedAbsoluteDependencyDirectory: tools,
  effectRealRoot: effectRoot, effect: '4.1.2', results })}\n`)
