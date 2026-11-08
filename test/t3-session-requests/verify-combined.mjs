import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readRequestSource } from './source-fixture.mjs'
import { buildRequestPrivacyManifest } from './build-manifest.mjs'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { applyRequestPrivacyPatches, requestPrivacyManifestBytes } from '../../patches/t3-session/requests/index.mjs'

// Execute this checkout's current producer, with its bytes checked against the integrated commit.
const producerCommit = '41b35a2f3d1473839ae854aa460d7ce79d7f33ff'
const rejectedCommit = 'db4bd5972777bcfae2df4f00f0292581bc17fb97'
const root = fileURLToPath(new URL('../../', import.meta.url))
const committed = (commit, path) => execFileSync('git', ['--no-replace-objects', 'show', `${commit}:${path}`], {
  cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const producerInputs = {}
for (const path of ['packaging/session-engine/patches.mjs', 'packaging/session-engine/engine-snapshot.mjs']) {
  const bytes = readFileSync(new URL(`../../${path}`, import.meta.url))
  assert.deepEqual(bytes, committed(producerCommit, path))
  producerInputs[path] = hash(bytes)
}
const extractionPath = 'patches/t3-session/extraction/boundary-patches.json'
const extractionBytes = readFileSync(new URL(`../../${extractionPath}`, import.meta.url))
assert.deepEqual(extractionBytes, committed(producerCommit, extractionPath))
assert.equal(hash(extractionBytes), 'd24f1709b6d7c1211d9987179d3fc727ef51e9c54d7c6900a1fceb8f900f1908')
const extraction = JSON.parse(extractionBytes)
assert.equal(extraction.patches.length, 124)
const privacyFiles = new Set(JSON.parse(requestPrivacyManifestBytes).patches.map(patch => patch.file))
assert.equal(privacyFiles.size, 6)
assert.deepEqual(extraction.patches.filter(patch => privacyFiles.has(patch.file)), [])

const { original, snapshot, manifestBytes } = await readRequestSource()
assert.deepEqual(buildRequestPrivacyManifest(original), requestPrivacyManifestBytes)
const manifest = JSON.parse(manifestBytes)
assert.deepEqual(manifest.families.map(family => family.id),
  ['state', 'client-connection', 'extraction', 'session-control', 'request-privacy'])
assert.equal(snapshot.identity.orderedPatchesSha256, hash(manifestBytes))
assert.equal(snapshot.identity.archiveSha256, original.identity.archiveSha256)
const independent = applyRequestPrivacyPatches(original)
for (const file of privacyFiles) assert.deepEqual(snapshot.read(file), independent.read(file))
assert.throws(() => applyRequestPrivacyPatches(snapshot), /SOURCE_MISMATCH/)
const rejectedBytes = committed(rejectedCommit, 'patches/t3-session/requests/boundary-patches.json')
assert.equal(hash(rejectedBytes), '8f11f629fb93f3234f4e5ffff8bc49f1bdfa5f0ff773af9c65c16ba5fcf040d3')
const rejected = applySessionEngineBoundaryPatches(original, rejectedBytes)
assert.throws(() => applyRequestPrivacyPatches(rejected), /SOURCE_MISMATCH/)
assert.throws(() => applySessionEngineBoundaryPatches(snapshot, rejectedBytes), /SOURCE_MISMATCH/)
console.log(JSON.stringify({ producerCommit, producerInputs, extractionManifestSha256: hash(extractionBytes),
  extractionOperations: extraction.patches.length, privacyManifestSha256: hash(requestPrivacyManifestBytes),
  combinedManifestSha256: hash(manifestBytes), patchOperations: manifest.patches.length,
  families: manifest.families, privacyFilesUnchangedByExtraction: privacyFiles.size,
  finalFiles: Object.fromEntries([...privacyFiles].map(file => [file, hash(snapshot.read(file))])),
  rejectedBoundaryRefused: true, replayRefused: true, productionIntegration: false, engineTypecheck: false, bundle: false }))
