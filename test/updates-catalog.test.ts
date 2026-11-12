import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { signCatalog } from '../packaging/updates/sign-catalog.mjs'
import { verifyUpdateManifest } from '../src/updates/manifest.js'

test('the release authoring interface signs valid immutable metadata and rejects another trust root', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const now = Date.parse('2026-11-05T12:00:00Z')
  const manifest = { format: 1, channel: 'stable', sequence: 1, version: '1.0.0', sourceCommit: 'a'.repeat(40),
    publishedAt: '2026-11-05T00:00:00Z', expiresAt: '2026-11-12T00:00:00Z', minimumUpdaterProtocol: 1,
    targets: { 'windows-x64-msi': [{ name: 'NessieExecutor_1.0.0_x64.msi', size: 100, sha256: 'b'.repeat(64),
      url: 'https://github.com/UnlikeOtherAI/nessie-computer/releases/download/executor-v1.0.0/NessieExecutor_1.0.0_x64.msi',
    }] } }
  const envelope = signCatalog(manifest, privatePem, publicPem, now)
  assert.equal(verifyUpdateManifest(envelope, publicPem, { now, channel: 'stable', highestSequence: 0 })
    .manifest.sourceCommit, manifest.sourceCommit)
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.throws(() => signCatalog(manifest, privatePem, other, now), /trust root/)
  assert.throws(() => signCatalog({ ...manifest, targets: {} }, privatePem, publicPem, now), /update.invalid_manifest/)
  assert.throws(() => signCatalog({ ...manifest, version: '0.0.0-beta' }, privatePem, publicPem, now), /update.invalid_manifest/)
})
