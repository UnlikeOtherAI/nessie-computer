import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { verifyUpdateManifest } from '../src/updates/manifest.ts'

// The installed native updater names the Mac package `darwin-arm64-dmg`
// (updater/src/protocol.rs); release metadata must use the same key.
test('accepts the Mac DMG target the native updater installs', () => {
  const key = generateKeyPairSync('ed25519')
  const now = Date.UTC(2026, 10, 6)
  const payload = Buffer.from(JSON.stringify({ format: 1, channel: 'preview', sequence: 1, version: '0.9.1',
    sourceCommit: 'a'.repeat(40), publishedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(), minimumUpdaterProtocol: 1,
    targets: { 'darwin-arm64-dmg': [{ name: 'NessieExecutor_0.9.1_arm64.dmg', size: 1, sha256: 'b'.repeat(64),
      url: 'https://github.com/UnlikeOtherAI/nessie-computer/releases/download/executor-v0.9.1/NessieExecutor_0.9.1_arm64.dmg' }] } }))
  const envelope = JSON.stringify({ payload: payload.toString('base64'),
    signature: sign(null, payload, key.privateKey).toString('base64') })
  const checked = verifyUpdateManifest(envelope, key.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    { now, channel: 'preview', highestSequence: 0 })
  assert.equal(checked.manifest.targets['darwin-arm64-dmg']?.[0]?.size, 1)
})
