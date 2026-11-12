import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { compareUpdateVersions, UpdateError, verifyUpdateManifest } from '../src/updates/manifest.js'

const key = generateKeyPairSync('ed25519')
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const now = Date.parse('2026-11-05T12:00:00Z')
const release = () => ({
  format: 1, channel: 'stable', sequence: 12, version: '1.0.2', sourceCommit: 'a'.repeat(40),
  publishedAt: '2026-11-05T10:00:00Z', expiresAt: '2026-11-12T10:00:00Z', minimumUpdaterProtocol: 1,
  targets: { 'windows-x64-msi': [{ name: 'Nessie-Executor-Windows.msi', size: 120,
    url: 'https://github.com/UnlikeOtherAI/nessie-computer/releases/download/executor-v1.0.2/Nessie-Executor-Windows.msi',
    sha256: 'b'.repeat(64) }] },
})
const envelope = (value: unknown): string => {
  const payload = Buffer.from(JSON.stringify(value))
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key.privateKey).toString('base64') })
}
const options = { now, channel: 'stable' as const, highestSequence: 0 }
const rejects = (body: string, code: string, overrides = {}): void => assert.throws(
  () => verifyUpdateManifest(body, publicKey, { ...options, ...overrides }),
  error => error instanceof UpdateError && error.code === code,
)

test('an authenticated release binds exact source, platform and immutable artifact bytes', () => {
  const body = envelope(release())
  const checked = verifyUpdateManifest(body, publicKey, options)
  assert.equal(checked.manifest.version, '1.0.2')
  assert.equal(checked.manifest.sourceCommit, 'a'.repeat(40))
  assert.equal(checked.manifest.targets['windows-x64-msi']?.[0]?.sha256, 'b'.repeat(64))
  assert.equal(verifyUpdateManifest(body, publicKey, {
    ...options, highestSequence: 12, previousDigest: checked.digest,
  }).digest, checked.digest, 'an identical retry remains idempotent')
})

test('modified or substituted payloads and signatures never reach release interpretation', () => {
  const parsed = JSON.parse(envelope(release())) as { payload: string; signature: string }
  parsed.payload = Buffer.from(JSON.stringify({ ...release(), version: '1.0.3' })).toString('base64')
  rejects(JSON.stringify(parsed), 'update.invalid_signature')
  rejects(JSON.stringify({ ...parsed, signature: Buffer.alloc(64).toString('base64') }), 'update.invalid_signature')
  rejects(JSON.stringify({ ...parsed, payload: `${parsed.payload}\n` }), 'update.invalid_signature')
})

test('rollback, equivocation, expiry, preview and unsupported updater protocols are refused', () => {
  rejects(envelope(release()), 'update.replayed_manifest', { highestSequence: 13 })
  rejects(envelope(release()), 'update.replayed_manifest', { highestSequence: 12, previousDigest: 'c'.repeat(64) })
  rejects(envelope({ ...release(), expiresAt: '2026-11-05T11:00:00Z' }), 'update.expired_manifest')
  rejects(envelope({ ...release(), publishedAt: '2026-11-06T11:00:00Z' }), 'update.expired_manifest')
  rejects(envelope({ ...release(), channel: 'preview' }), 'update.wrong_channel')
  rejects(envelope({ ...release(), minimumUpdaterProtocol: 2 }), 'update.updater_required')
})

test('signed moving URLs, foreign repositories, path tricks and duplicate assets are refused', () => {
  const asset = release().targets['windows-x64-msi'][0]!
  for (const url of [asset.url.replace('executor-v1.0.2', 'latest'), asset.url.replace('nessie-computer', 'another-repo'),
    `${asset.url}?download=1`, asset.url.replace('/Nessie-', '/../../Nessie-')]) {
    rejects(envelope({ ...release(), targets: { 'windows-x64-msi': [{ ...asset, url }] } }), 'update.invalid_asset')
  }
  rejects(envelope({ ...release(), targets: { 'windows-x64-msi': [asset, asset] } }), 'update.invalid_asset')
})

test('version ordering is independent of repository commit counts and never uses lexical comparison', () => {
  assert.equal(compareUpdateVersions('1.0.0', '0.0.65000'), 1)
  assert.equal(compareUpdateVersions('1.0.12', '1.0.9'), 1)
  assert.equal(compareUpdateVersions('1.0.12', '1.0.12'), 0)
  assert.equal(compareUpdateVersions('1.0.2', '1.1.0'), -1)
  assert.throws(() => compareUpdateVersions('1.0', '1.0.0'))
})

// A rename must not invalidate an authenticated release already held by a computer.
test('signed catalogues retain the exact former repository alias', () => {
  const value = release()
  value.targets['windows-x64-msi'][0]!.url = value.targets['windows-x64-msi'][0]!.url
    .replace('nessie-computer', 'nessie-executor')
  assert.equal(verifyUpdateManifest(envelope(value), publicKey, options).manifest.version, '1.0.2')
})
