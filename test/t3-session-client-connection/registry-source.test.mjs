import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { applyRegistryConnectionPatches, registryConnectionManifestBytes } from '../../patches/t3-session/client-connection/index.mjs'
import { readCommittedFile, sha256 } from './source-fixture.mjs'
import { sourceFunctions } from './source-functions.mjs'

const repository = process.env.T3_CLIENT_CONNECTION_SOURCE_REPOSITORY
if (!repository) throw new Error('Explicit read-only T3_CLIENT_CONNECTION_SOURCE_REPOSITORY is required')
const manifest = JSON.parse(registryConnectionManifestBytes)
const files = [...new Set(manifest.patches.map(patch => patch.file))]
const bytes = new Map(await Promise.all(files.map(async file => [file, await readCommittedFile(repository, file)])))
const original = { identity: { commit: manifest.sourceCommit }, files, read: file => Buffer.from(bytes.get(file)) }
const patched = applyRegistryConnectionPatches(original)

test('registry patches verify every original/intermediate/final digest and strip without a compiler', () => {
  for (const file of files) {
    assert.equal(sha256(patched.read(file)), manifest.patches.filter(patch => patch.file === file).at(-1).afterSha256)
    assert.doesNotThrow(() => stripTypeScriptTypes(patched.read(file).toString(), { sourceUrl: file }))
  }
  assert.throws(() => applyRegistryConnectionPatches(patched), /SOURCE_MISMATCH/)
  assert.throws(() => applyRegistryConnectionPatches({ ...original, read: () => Buffer.from('changed') }), /SOURCE_MISMATCH/)
})

test('actual shared catalog function preserves disabled platform preferences without saved targets', () => {
  const { setConnectionEnabledInCatalog } = sourceFunctions(patched,
    'packages/client-runtime/src/platform/storageDocument.ts', 'export function setConnectionEnabledInCatalog(',
    'export function putRemoteDpopTokenInCatalog(', ['setConnectionEnabledInCatalog'], {
      removeCatalogValue: (values, key, removed) => values.filter(value => key(value) !== removed),
    })
  const empty = { targets: [], credentials: [], disabledEnvironmentIds: [] }
  const disabled = setConnectionEnabledInCatalog(empty, 'original-environment', false)
  assert.deepEqual(disabled, { ...empty, disabledEnvironmentIds: ['original-environment'] })
  assert.deepEqual(setConnectionEnabledInCatalog(disabled, 'original-environment', false), disabled)
  assert.deepEqual(setConnectionEnabledInCatalog(disabled, 'original-environment', true), empty)
})
