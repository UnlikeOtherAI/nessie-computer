import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { readRequestSource } from './source-fixture.mjs'
import { buildRequestPrivacyManifest } from './build-manifest.mjs'
import { applySessionEngineBoundaryPatches } from '../../packaging/session-engine/patches.mjs'
import { applyRequestPrivacyPatches, requestPrivacyManifestBytes } from '../../patches/t3-session/requests/index.mjs'

// Preserve the frozen producer/legacy evidence and verify the current composed source separately.
const producerCommit = '15611588af2ffe71b426b3989a7cee0fd66a04d8'
const rejectedCommit = 'db4bd5972777bcfae2df4f00f0292581bc17fb97'
const root = fileURLToPath(new URL('../../', import.meta.url))
const committed = (commit, path) => execFileSync('git', ['--no-replace-objects', 'show', `${commit}:${path}`], {
  cwd: root, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const producerInputs = {}
for (const path of ['packaging/session-engine/patches.mjs', 'packaging/session-engine/engine-snapshot.mjs']) {
  const bytes = readFileSync(new URL(`../../${path}`, import.meta.url))
  const legacy = committed(producerCommit, path)
  if (path === 'packaging/session-engine/patches.mjs') {
    assert.equal(hash(legacy), '3c0f810e3160e8f06d70ff7ba21b8d6d482986786f8278b316bf4b480f191bca')
    assert.equal(hash(bytes), 'f06017a5328d9d947137a952d2809e87717e1887c16af791b4f1e2e9efe4deac')
  } else assert.deepEqual(bytes, legacy)
  producerInputs[path] = hash(bytes)
}
const extractionPath = 'patches/t3-session/extraction/boundary-patches.json'
const extractionBytes = readFileSync(new URL(`../../${extractionPath}`, import.meta.url))
const legacyExtraction = committed(producerCommit, extractionPath)
assert.equal(hash(legacyExtraction), '7af46ac8bf7d67cd59bb986150db5324e709856d94755d29e029858177a9a4ac')
assert.equal(JSON.parse(legacyExtraction).patches.length, 150)
assert.equal(hash(extractionBytes), '63dbd14c638f1d6dad71520f883f58888c77f866c68afac3ea8c5dc9d6dde302')
const extraction = JSON.parse(extractionBytes)
assert.equal(extraction.patches.length, 343)
const privacyFiles = new Set(JSON.parse(requestPrivacyManifestBytes).patches.map(patch => patch.file))
assert.equal(privacyFiles.size, 8)
const overlapping = [...new Set(extraction.patches.filter(patch => privacyFiles.has(patch.file))
  .map(patch => patch.file))].sort()
assert.deepEqual(overlapping, ['apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.session-live.ts',
  'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts',
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.session-live.ts',
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts'])

const { original, prefix, snapshot, manifestBytes } = await readRequestSource()
assert.deepEqual(buildRequestPrivacyManifest(prefix), requestPrivacyManifestBytes)
const manifest = JSON.parse(manifestBytes)
assert.deepEqual(manifest.families.map(family => family.id),
  ['state', 'client-connection', 'client-registry', 'client-host', 'extraction', 'catalog', 'files',
    'session-control', 'request-privacy'])
assert.equal(snapshot.identity.orderedPatchesSha256, hash(manifestBytes))
assert.equal(snapshot.identity.archiveSha256, original.identity.archiveSha256)
const independent = applyRequestPrivacyPatches(prefix)
for (const file of privacyFiles) assert.deepEqual(snapshot.read(file), independent.read(file))
assert.throws(() => applyRequestPrivacyPatches(snapshot), /SOURCE_MISMATCH/)
assert.throws(() => applyRequestPrivacyPatches(original), /SOURCE_MISMATCH/)
const rejectedBytes = committed(rejectedCommit, 'patches/t3-session/requests/boundary-patches.json')
assert.equal(hash(rejectedBytes), '8f11f629fb93f3234f4e5ffff8bc49f1bdfa5f0ff773af9c65c16ba5fcf040d3')
const rejected = applySessionEngineBoundaryPatches(original, rejectedBytes)
assert.throws(() => applyRequestPrivacyPatches(rejected), /SOURCE_MISMATCH/)
assert.throws(() => applySessionEngineBoundaryPatches(snapshot, rejectedBytes), /SOURCE_MISMATCH/)
console.log(JSON.stringify({ producerCommit, producerInputs, extractionManifestSha256: hash(extractionBytes),
  extractionOperations: extraction.patches.length, privacyManifestSha256: hash(requestPrivacyManifestBytes),
  combinedManifestSha256: hash(manifestBytes), patchOperations: manifest.patches.length,
  families: manifest.families, privacyAppliedAfterExtraction: overlapping,
  finalFiles: Object.fromEntries([...privacyFiles].map(file => [file, hash(snapshot.read(file))])),
  rejectedBoundaryRefused: true, replayRefused: true, productionIntegration: false,
  engineTypecheck: false, bundle: false }))
