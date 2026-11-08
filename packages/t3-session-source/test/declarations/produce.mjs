import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readSessionEngineSnapshot } from '../../../../packaging/session-engine/snapshot.mjs'
import { T3_SESSION_ENGINE_SOURCE } from '../../../../packaging/session-engine/source.mjs'
import { typecheckSessionState } from '../../../../packaging/session-engine/typecheck.mjs'
import { writeContractDeclarationEntries } from '../../../../packaging/session-engine/declarations.mjs'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(process.argv[2])
const snapshot = await readSessionEngineSnapshot(resolve(root, '../../packaging/session-engine/.artifacts',
  `source-${T3_SESSION_ENGINE_SOURCE.archiveSha256}.tar`))
const selection = JSON.parse(await readFile(resolve(root, 'selection.json'), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const { path, sha256 } of selection) assert.equal(hash(snapshot.read(path)), sha256)
const checked = await typecheckSessionState(snapshot, 't3-source:packages/contracts/src/index.ts', {
  declarationDirectory: resolve(output, 'dist/engine-types'), sharedContracts: true,
  additionalEntries: { settings: 't3-source:packages/contracts/src/settings.ts',
    relay: 't3-source:packages/contracts/src/relay.ts' },
})
const entries = await writeContractDeclarationEntries(resolve(output, 'dist'))
const contracts = Object.keys(checked.declarations.files).filter(path => path.startsWith('../types/source/'))
assert.equal(contracts.length, selection.length)
assert.equal(checked.contractNaming.length, 5)
assert.deepEqual(checked.authoredInputs, {})
// Use the real export map. This candidate qualifies only its three contract entries.
await writeFile(resolve(output, 'package.json'), await readFile(resolve(root, 'package.json')))
const report = { kind: 'original-contract-declarations-only', fullEnginePackage: false,
  sourceIdentity: snapshot.identity, checked, entries }
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ kind: report.kind, compiler: checked.compiler, sourceFiles: checked.sourceFiles,
  originalContracts: contracts.length, invariantNamingChecks: checked.contractNaming.length,
  declarationsSha256: checked.declarations.sha256, output }))
