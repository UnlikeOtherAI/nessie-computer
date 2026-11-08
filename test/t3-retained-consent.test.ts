import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { canonicalExecutorJson, retainedImportChallengeDigestInput } from '@nessie/executor-protocol'
import { parseRetainedImportChallenge, parseRetainedImportReceipt, parseRetainedImportVerification,
  parseRetainedImportLiveProof, retainedImportChallengeDigest } from '../src/t3-session/source/consent-contract.js'
import { consumeRetainedConsent } from '../src/t3-session/source/consent-consumer.js'

const now = Date.now()
const uuid = 'd18f1396-74e1-4329-bbaa-285424f1fb42'
const challenge = () => ({ version: 1 as const, challengeId: uuid, nonce: Buffer.alloc(32, 3).toString('base64url'),
  requestId: uuid, executorId: uuid, environmentId: 'original:environment', admittedRootKey: 'installation-one',
  physicalRootKey: 'windows-file-id:original', databaseIdentity: 'volume:database', environmentIdentity: 'volume:environment',
  organizationId: uuid, teamId: uuid, recipient: { subject: 'uoa:person', organizationId: 'uoa:org', teamId: 'uoa:team' },
  selection: { kind: 'threads' as const, threadIds: ['retained:b', 'retained:a'], projectIds: ['original:p2', 'original:p1'] },
  purpose: 'retained-import-read-publish' as const, grantGeneration: uuid, captureGeneration: 'capture:unchanged',
  acceptedBaseline: 'not_attested_by_original_source' as const, issuedAtMs: now - 1000,
  expiresAtMs: now + 120_000, grantExpiresAtMs: now + 100_000, issuerEnrollmentId: uuid, issuerKeyId: 'a'.repeat(64) })
const verification = () => ({ verificationId: uuid, nonce: Buffer.alloc(32, 4).toString('base64url'),
  issuedAtMs: now - 100, expiresAtMs: now + 20_000 })

test('native challenge digest equals public protocol tuple and preserves both explicit orders', () => {
  const c = parseRetainedImportChallenge(challenge(), now)
  assert.equal(retainedImportChallengeDigest(c), createHash('sha256')
    .update(canonicalExecutorJson(retainedImportChallengeDigestInput(challenge()))).digest('hex'))
  const reordered = challenge(); reordered.selection.projectIds.reverse()
  assert.notEqual(retainedImportChallengeDigest(c), retainedImportChallengeDigest(reordered))
  const changed = challenge(); changed.selection.threadIds.reverse()
  assert.notEqual(retainedImportChallengeDigest(c), retainedImportChallengeDigest(changed))
  for (const field of ['issuerEnrollmentId', 'issuerKeyId', 'captureGeneration', 'physicalRootKey'] as const) {
    assert.notEqual(retainedImportChallengeDigest(c), retainedImportChallengeDigest({ ...c, [field]: 'other' }))
  }
  assert.ok(Object.isFrozen(c.selection) && c.selection.kind === 'threads' && Object.isFrozen(c.selection.threadIds))
})
test('malformed, duplicate, overlong, expired, unknown and falsely attested challenges refuse', () => {
  for (const patch of [{ expiresAtMs: now }, { grantExpiresAtMs: now + 121_000 }, { issuedAtMs: now + 1 },
    { expiresAtMs: now + 300_000 }, { issuerEnrollmentId: 'not-uuid' }, { issuerKeyId: 'A'.repeat(64) },
    { nonce: `${'A'.repeat(42)}B` }, { acceptedBaseline: 'attested' }, { owner: true },
    { selection: { kind: 'threads', threadIds: ['a', 'a'], projectIds: [] } },
    { selection: { kind: 'threads', threadIds: ['a'], projectIds: ['p', 'p'] } },
    { selection: { kind: 'threads', threadIds: ['雪'.repeat(86)], projectIds: [] } },
    { selection: { kind: 'threads', threadIds: Array.from({ length: 65 }, (_, i) => String(i)), projectIds: [] } }]) {
    assert.throws(() => parseRetainedImportChallenge({ ...challenge(), ...patch }, now))
  }
})
test('receipt signature binds exact full challenge and unsigned receipt; parsing does not enroll keys', () => {
  // Test key signs vectors only. It cannot create native admission or a lease.
  const keys = generateKeyPairSync('ed25519')
  const der = keys.publicKey.export({ format: 'der', type: 'spki' })
  const c = { ...challenge(), issuerKeyId: createHash('sha256').update(der).digest('hex') }
  const unsigned = { version: 1, kind: 'native-source-owner-consent', challengeId: c.challengeId,
    challengeDigest: retainedImportChallengeDigest(c), receiptId: 'b'.repeat(64), issuerInstance: 'c'.repeat(64),
    expiresAtMs: c.expiresAtMs, issuerKeyId: c.issuerKeyId }
  const bytes = Buffer.from(canonicalExecutorJson({ domain: 'nessie.t3.retained-import.approval.v1',
    payload: { challenge: c, receipt: unsigned } }))
  const nativeSignature = sign(null, bytes, keys.privateKey).toString('base64')
  const r = parseRetainedImportReceipt({ ...unsigned, nativeSignature }, c)
  assert.ok(verify(null, bytes, createPublicKey({ format: 'der', type: 'spki', key: der }), Buffer.from(r.nativeSignature, 'base64')))
  assert.throws(() => parseRetainedImportReceipt({ ...r, issuerKeyId: 'f'.repeat(64) }, c))
  assert.throws(() => parseRetainedImportReceipt({ ...r, nativeSignature: `${nativeSignature}\n` }, c))
})
test('live proof is bound to one operation, verification, consumption and enrolled key', () => {
  const c = challenge(); const v = parseRetainedImportVerification(verification(), c, now)
  const r = parseRetainedImportReceipt({ version: 1, kind: 'native-source-owner-consent', challengeId: c.challengeId,
    challengeDigest: retainedImportChallengeDigest(c), receiptId: 'b'.repeat(64), issuerInstance: 'c'.repeat(64),
    expiresAtMs: c.expiresAtMs, issuerKeyId: c.issuerKeyId, nativeSignature: Buffer.alloc(64).toString('base64') }, c)
  const proof = { version: 1, operation: 'consume', verification: v, issuerKeyId: r.issuerKeyId,
    issuerInstance: r.issuerInstance, receiptId: r.receiptId, challengeDigest: r.challengeDigest,
    consumptionId: 'd'.repeat(64), observedAtMs: now, expiresAtMs: v.expiresAtMs, nativeSignature: r.nativeSignature }
  assert.equal(parseRetainedImportLiveProof(proof, c, r, v, 'consume', 'd'.repeat(64)).verification.nonce, v.nonce)
  for (const patch of [{ operation: 'recheck' }, { consumptionId: 'e'.repeat(64) }, { expiresAtMs: v.expiresAtMs + 1 },
    { verification: { ...v, nonce: Buffer.alloc(32, 5).toString('base64url') } }, { observedAtMs: now - 101 }]) {
    assert.throws(() => parseRetainedImportLiveProof({ ...proof, ...patch }, c, r, v, 'consume', 'd'.repeat(64)))
  }
})
test('a callback and fabricated JSON cannot create the actual machine source owner', async () => {
  let called = false
  await assert.rejects(consumeRetainedConsent(uuid, { challenge: challenge(), receipt: {}, verification: verification(),
    physicalSourceRecheck: async () => { called = true } }), /t3_source_machine_owner_not_running/u)
  assert.equal(called, false)
})
