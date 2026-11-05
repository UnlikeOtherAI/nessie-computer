import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

import {
  LocalLoopbackOriginError,
  assertLoopbackOrigin,
  ollamaObservationFingerprints,
  orderedOllamaLoopbackEndpoints,
  resolveOllamaLoopbackEndpoint,
  signLocalInferenceEnvelope,
  verifyLocalInferenceEnvelope,
} from '../src/index.js'

const hostId = '00000000-0000-4000-8000-000000000111'
const organizationId = '00000000-0000-4000-8000-000000000222'

const machineKeys = () => {
  const keys = generateKeyPairSync('ed25519')
  const publicDer = keys.publicKey.export({ format: 'der', type: 'spki' })
  const privateDer = keys.privateKey.export({ format: 'der', type: 'pkcs8' })
  return {
    machinePrivateKey: privateDer.toString('base64url'),
    machinePublicKey: publicDer.subarray(-32).toString('base64url'),
    machinePublicPem: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
}

test('a canonical host envelope verifies across reordered body keys', () => {
  const keys = machineKeys()
  const body = { attemptId: hostId, options: { keepAliveSeconds: 300, numCtx: 8192 } }
  const envelope = signLocalInferenceEnvelope({
    body,
    header: {
      connectionEpoch: '7',
      hostId,
      organizationId,
      protocolVersion: 1,
      purpose: 'poll',
      sentAt: '2026-09-20T12:00:00.000Z',
      sequence: 4,
    },
    machinePrivateKey: keys.machinePrivateKey,
  })
  assert.deepEqual(
    verifyLocalInferenceEnvelope({
      body: { options: { numCtx: 8192, keepAliveSeconds: 300 }, attemptId: hostId },
      envelope,
      machinePublicKey: keys.machinePublicKey,
    }),
    { envelope, ok: true },
  )
})

test('a changed body, purpose, or malformed machine key cannot verify a host envelope', () => {
  const keys = machineKeys()
  const envelope = signLocalInferenceEnvelope({
    body: { attemptId: hostId },
    header: {
      connectionEpoch: '7',
      hostId,
      organizationId,
      protocolVersion: 1,
      purpose: 'frames',
      sentAt: '2026-09-20T12:00:00.000Z',
      sequence: 5,
    },
    machinePrivateKey: keys.machinePrivateKey,
  })
  assert.deepEqual(
    verifyLocalInferenceEnvelope({
      body: { attemptId: organizationId },
      envelope,
      machinePublicKey: keys.machinePublicKey,
    }),
    { ok: false, reason: 'body_digest_mismatch' },
  )
  assert.deepEqual(
    verifyLocalInferenceEnvelope({
      body: { attemptId: hostId },
      envelope: { ...envelope, purpose: 'heartbeat' },
      machinePublicKey: keys.machinePublicKey,
    }),
    { ok: false, reason: 'invalid_signature' },
  )
  assert.deepEqual(
    verifyLocalInferenceEnvelope({ body: { attemptId: hostId }, envelope, machinePublicKey: 'invalid' }),
    { ok: false, reason: 'invalid_machine_key' },
  )
})

test('a Desktop PEM enrollment key verifies the same signed host envelope', () => {
  const keys = machineKeys()
  const body = { paused: false }
  const envelope = signLocalInferenceEnvelope({
    body,
    header: {
      connectionEpoch: '1', hostId, organizationId, protocolVersion: 1,
      purpose: 'heartbeat', sentAt: '2026-09-20T12:00:00.000Z', sequence: 1,
    },
    machinePrivateKey: keys.machinePrivateKey,
  })
  assert.equal(verifyLocalInferenceEnvelope({
    body, envelope, machinePublicKey: keys.machinePublicPem,
  }).ok, true)
})

test('a terminal receipt has a separate signing domain from a streamed frame', () => {
  const keys = machineKeys()
  const body = { attemptId: hostId, dispatchFence: 1, result: { content: 'ok' } }
  const envelope = signLocalInferenceEnvelope({
    body,
    header: {
      connectionEpoch: '3', hostId, organizationId, protocolVersion: 1,
      purpose: 'result', sentAt: '2026-09-20T12:00:00.000Z', sequence: 1,
    },
    machinePrivateKey: keys.machinePrivateKey,
  })
  assert.equal(verifyLocalInferenceEnvelope({
    body, envelope, machinePublicKey: keys.machinePublicKey,
  }).ok, true)
  assert.equal(verifyLocalInferenceEnvelope({
    body, envelope: { ...envelope, purpose: 'frames' }, machinePublicKey: keys.machinePublicKey,
  }).ok, false)
})

test('the executor connection fence is signed and cannot be upgraded in transit', () => {
  const keys = machineKeys()
  const body = { attemptId: hostId }
  const envelope = signLocalInferenceEnvelope({
    body,
    header: {
      connectionEpoch: '3',
      executorConnectionEpoch: '11',
      hostId,
      organizationId,
      protocolVersion: 1,
      purpose: 'poll',
      sentAt: '2026-09-20T12:00:00.000Z',
      sequence: 1,
    },
    machinePrivateKey: keys.machinePrivateKey,
  })
  assert.equal(verifyLocalInferenceEnvelope({
    body, envelope, machinePublicKey: keys.machinePublicKey,
  }).ok, true)
  assert.equal(verifyLocalInferenceEnvelope({
    body,
    envelope: { ...envelope, executorConnectionEpoch: '12' },
    machinePublicKey: keys.machinePublicKey,
  }).ok, false)
})

test('discovery ordering is deterministic and refuses DNS or competing local daemons', () => {
  assert.deepEqual(orderedOllamaLoopbackEndpoints('http://127.0.0.1:11434'), [
    'http://127.0.0.1:11434',
    'http://[::1]:11434',
  ])
  assert.throws(() => assertLoopbackOrigin('http://localhost:11434'), LocalLoopbackOriginError)

  const shared = ollamaObservationFingerprints({
    modelManifestDigests: ['a'.repeat(64)],
    version: '0.34.1',
  })
  assert.deepEqual(resolveOllamaLoopbackEndpoint({
    evidence: [
      { ...shared, origin: 'http://[::1]:11434' },
      { ...shared, origin: 'http://127.0.0.1:11434' },
    ],
  }), { canonicalSocket: 'http://127.0.0.1:11434', kind: 'selected' })

  const different = ollamaObservationFingerprints({
    modelManifestDigests: ['b'.repeat(64)],
    version: '0.34.1',
  })
  assert.deepEqual(resolveOllamaLoopbackEndpoint({
    evidence: [
      { ...different, origin: 'http://[::1]:11434' },
      { ...shared, origin: 'http://127.0.0.1:11434' },
    ],
  }), { candidates: ['http://127.0.0.1:11434', 'http://[::1]:11434'], kind: 'conflict' })
})
