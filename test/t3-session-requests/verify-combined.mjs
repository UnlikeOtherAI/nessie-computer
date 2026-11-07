import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SourceTextModule, SyntheticModule } from 'node:vm'

import * as sourceApi from '../../packaging/session-engine/source.mjs'
import { readSessionEngineSnapshot } from '../../packaging/session-engine/snapshot.mjs'
import { applyRequestPrivacyPatches, requestPrivacyManifestBytes } from '../../patches/t3-session/requests/index.mjs'
import { clientConnectionManifestBytes } from '../../patches/t3-session/client-connection/index.mjs'
import { scratch } from './source-fixture.mjs'

// Optional committed-producer compatibility proof. No checkout, merge, code copy or dependency install.
const commit = '6dbf5e39ef1289e8fab76d09ca4052efbd855274'
const executorRoot = fileURLToPath(new URL('../../', import.meta.url))
const execute = promisify(execFile)
const readCommitted = async path => (await execute('git', [
  '--no-replace-objects', '-C', executorRoot, 'show', `${commit}:${path}`,
], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true, timeout: 10000 })).stdout
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const extractionBytes = await readCommitted('patches/t3-session/extraction/boundary-patches.json')
assert.equal(hash(extractionBytes), '49f5dad346bc6bacb1134df0da0ee301071bb4c171b5fb3d765fecc52c671bb6')
const producerBytes = await readCommitted('packaging/session-engine/patches.mjs')
const extraction = JSON.parse(extractionBytes)
assert.equal(extraction.patches.length, 116)
const privacyFiles = new Set(JSON.parse(requestPrivacyManifestBytes).patches.map(patch => patch.file))
assert.deepEqual(extraction.patches.filter(patch => privacyFiles.has(patch.file)), [])

// Evaluate the exact committed producer helper with real builtins and C02's actual error class.
// Its relative default-manifest URL points at this owned checkout's unchanged C02 manifest.
const module = new SourceTextModule(producerBytes.toString(), {
  identifier: `${commit}:packaging/session-engine/patches.mjs`,
  initializeImportMeta: meta => { meta.url = pathToFileURL(resolve(executorRoot, 'packaging/session-engine/patches.mjs')).href },
})
const imports = { 'node:crypto': crypto, 'node:fs': fs, './source.mjs': sourceApi }
await module.link(specifier => {
  const values = imports[specifier]
  if (!values) throw new Error('UNEXPECTED_COMMITTED_PRODUCER_IMPORT')
  return new SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  })
})
await module.evaluate()
const snapshot = await readSessionEngineSnapshot(resolve(scratch, 'source.tar'))
const families = [
  { id: 'state', bytes: fs.readFileSync(new URL('../../packaging/session-engine/boundary-patches.json', import.meta.url)) },
  { id: 'client-connection', bytes: clientConnectionManifestBytes },
  { id: 'extraction', bytes: extractionBytes },
  { id: 'request-privacy', bytes: requestPrivacyManifestBytes },
]
const manifest = module.namespace.composeSessionEnginePatchManifests(snapshot, families)
const combined = module.namespace.applySessionEngineBoundaryPatches(snapshot, manifest)
assert.equal(combined.identity.orderedPatchesSha256, hash(manifest))
assert.equal(combined.identity.archiveSha256, snapshot.identity.archiveSha256)
const ownPatched = applyRequestPrivacyPatches(snapshot)
for (const file of privacyFiles) assert.deepEqual(combined.read(file), ownPatched.read(file))
const port = 'apps/server/src/secrets/SecretRequests.session-port.ts'
assert.equal(hash(combined.read(port)), '4d81dc85b97e1c1e9032a63b2275e39b74c9df293cabbd8608b361ba2a149c15')
assert.throws(() => module.namespace.composeSessionEnginePatchManifests(combined, families), /COMPOSITION_REFUSED/)
console.log(JSON.stringify({ producerCommit: commit, producerHelperSha256: hash(producerBytes),
  extractionManifestSha256: hash(extractionBytes), privacyManifestSha256: hash(requestPrivacyManifestBytes),
  combinedManifestSha256: hash(manifest), patchOperations: JSON.parse(manifest).patches.length,
  privacyFilesUnchangedByExtraction: privacyFiles.size, requiredSecretPortSha256: hash(combined.read(port)),
  productionIntegration: false, engineTypecheck: false, bundle: false }))
