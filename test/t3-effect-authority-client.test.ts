import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import test from 'node:test'
import { canonicalExecutorJson, canonicalExecutorPayload } from '@nessie/executor-protocol'
import { T3_EFFECT_SIGNATURE_DOMAIN, type T3EffectSelection } from '@nessie/executor-protocol/t3-session'
import { executorApi } from '../src/api-client.js'
import { createT3EffectAuthorityClient, assertVerifiedT3EffectGrant } from '../src/t3-effect-authority-client.js'
import type { ExecutorLocalState } from '../src/state-store.js'

test('finite grant verifies actual signature, exact challenge and target; serialized and substituted grants fail', async t => {
  const machine = generateKeyPairSync('ed25519')
  const issuer = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const state = { executorId: randomUUID(), connectionEpoch: '1', apiBaseUrl: 'https://nessie.test',
    machinePrivateKey: machine.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    machinePublicKey: machine.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  } as ExecutorLocalState
  const selection: T3EffectSelection = { kind: 't3-effect', version: 1, purpose: 'execute',
    executorId: state.executorId, environmentId: 'original:environment', threadId: 'original:thread',
    providerSessionId: 'original:provider-session', connectionEpoch: '1', runtimeGeneration: 'held:runtime',
    correlationId: 'attempt:one', commandId: 'command:one', requestDigest: `hmac-sha256:${'a'.repeat(64)}`,
    nativeAssociation: { driver: 'codex', nativeId: 'native:one', continuationHomeKey: 'home:one', historyHomeKey: 'home:one' } }
  let corrupt = false
  t.mock.method(executorApi, 't3EffectIssuerKeys', async () => ({ keys: [
    { ...issuer.publicKey.export({ format: 'jwk' }), kid: 'existing-issuer', alg: 'RS256', use: 'sig' },
  ] }))
  t.mock.method(executorApi, 'checkT3EffectAuthority', async (_base, input) => {
    const { signature: _signature, ...payload } = input
    const grant = { ...input.selection, issuedAt: input.observedAt,
      expiresAt: new Date(Date.parse(input.observedAt) + 5_000).toISOString(), requestNonce: input.requestNonce,
      requestProofDigest: `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}` }
    const signature = sign('RSA-SHA256', Buffer.from(canonicalExecutorPayload(T3_EFFECT_SIGNATURE_DOMAIN, grant)),
      issuer.privateKey).toString('base64url')
    return { grant: corrupt ? { ...grant, threadId: 'substituted' } : grant, keyId: 'existing-issuer', signature }
  })
  const client = createT3EffectAuthorityClient(() => state)
  const grant = await client.issue(selection)
  assertVerifiedT3EffectGrant(grant)
  assert.equal(grant.issuerOrigin, 'https://nessie.test')
  assert.throws(() => assertVerifiedT3EffectGrant(grant.reference), /REFUSED/)
  assert.throws(() => Reflect.construct(Object.getPrototypeOf(grant).constructor,
    [Symbol('forged'), grant.reference, grant.issuerOrigin, async () => grant]), /REFUSED/)
  const copy = grant.reference
  copy.threadId = 'substituted'
  assert.equal(grant.reference.threadId, selection.threadId)
  const proof = grant.signedProof
  assert.deepEqual(proof.grant, grant.reference)
  assert.equal(verify('RSA-SHA256', Buffer.from(canonicalExecutorPayload(T3_EFFECT_SIGNATURE_DOMAIN, proof.grant)),
    issuer.publicKey, Buffer.from(proof.signature, 'base64url')), true)
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.grant) && Object.isFrozen(proof.grant.nativeAssociation))
  assert.throws(() => { proof.signature = 'substituted' })
  assert.throws(() => { proof.grant.nativeAssociation.nativeId = 'substituted' })
  assert.throws(() => assertVerifiedT3EffectGrant(proof), /REFUSED/)
  const fresh = await grant.consume()
  assertVerifiedT3EffectGrant(fresh)
  assert.notEqual(fresh.signedProof.grant.requestNonce, proof.grant.requestNonce)
  assert.notEqual(fresh.signedProof.signature, proof.signature)
  assert.notEqual(grant.signedProof, proof)
  corrupt = true
  await assert.rejects(client.issue(selection), /REFUSED/)
  state.apiBaseUrl = 'http://nessie.test'
  await assert.rejects(client.issue(selection), /REFUSED/)
})
