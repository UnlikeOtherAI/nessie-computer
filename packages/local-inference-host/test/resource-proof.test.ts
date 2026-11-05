import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ExecutorInferenceSource } from '@nessie/executor-protocol'
import { signLocalInferenceResourceAttachment, verifyLocalInferenceResourceAttachment } from '../src/resource-proof.js'

test('one coordinator key authenticates both transports but cannot be moved to another host or epoch', () => {
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const attachment = {
    hostId: randomUUID(), organizationId: randomUUID(), connectionEpoch: '1',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
  const signed = { ...attachment, signature: signLocalInferenceResourceAttachment(attachment, privateKey) }
  const fingerprint = verifyLocalInferenceResourceAttachment(signed)
  assert.ok(fingerprint)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, connectionEpoch: '2' }), null)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, hostId: randomUUID() }), null)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, organizationId: randomUUID() }), null)
  const sibling = { ...attachment, hostId: randomUUID() }
  assert.equal(verifyLocalInferenceResourceAttachment({
    ...sibling, signature: signLocalInferenceResourceAttachment(sibling, privateKey),
  }), fingerprint)
})

test('cloud proof binds every source fence and cannot reuse or downgrade a physical attachment', () => {
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const source: ExecutorInferenceSource = { kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan',
    profileId: randomUUID(), accountGeneration: 2, consentRevision: 3 }
  const physical = { hostId: randomUUID(), organizationId: randomUUID(), connectionEpoch: '1',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
  const attachment = { ...physical, inferenceSource: source }
  const signed = { ...attachment, signature: signLocalInferenceResourceAttachment(attachment, privateKey) }
  assert.ok(verifyLocalInferenceResourceAttachment(signed))
  for (const altered of [{ ...source, profileId: randomUUID() }, { ...source, accountGeneration: 3 },
    { ...source, consentRevision: 4 }, { kind: 'local_weights' as const }, undefined]) {
    assert.equal(verifyLocalInferenceResourceAttachment({ ...signed, inferenceSource: altered }), null)
  }
  const physicalSignature = signLocalInferenceResourceAttachment(physical, privateKey)
  assert.equal(verifyLocalInferenceResourceAttachment({ ...attachment, signature: physicalSignature }), null)
  assert.equal(signLocalInferenceResourceAttachment({ ...physical, inferenceSource: { kind: 'local_weights' } }, privateKey),
    physicalSignature, 'default local byte contract is preserved')
})
