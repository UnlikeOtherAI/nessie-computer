import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import { T3EffectGrantReferenceSchema, type T3EffectGrantReference } from '@nessie/executor-protocol/t3-session'
import type { VerifiedT3EffectGrant } from '../src/t3-effect-authority-client.js'
import { EffectPipe, EffectReceiver, sameEffectSession } from '../src/coding-session/effect-channel.js'
import { requestT3EffectAuthority, SessionEffectAuthority } from '../src/coding-session/session-effect-authority.js'
import { sameT3EffectOperation } from '../src/coding-session/session-effect-scope.js'

// Structural receiver fixtures, never an admitted human operation or a signed grant.
const reference = (): T3EffectGrantReference => ({
  kind: 't3-effect', version: 1, purpose: 'execute', executorId: randomUUID(),
  environmentId: 'original-environment', threadId: 'original-thread', providerSessionId: 'original-provider-session',
  connectionEpoch: '7', runtimeGeneration: 'runtime-generation', correlationId: 'request-correlation',
  commandId: 'original-command', requestDigest: `hmac-sha256:${'a'.repeat(64)}`,
  nativeAssociation: { driver: 'codex', nativeId: 'native-app-session', continuationHomeKey: 'continuation-home',
    historyHomeKey: 'history-home' },
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4_000).toISOString(),
  requestNonce: randomUUID(), requestProofDigest: `sha256:${'b'.repeat(64)}`,
})
const pair = () => {
  const a = new PassThrough(), b = new PassThrough()
  return [new EffectPipe(Duplex.from({ readable: a, writable: b })),
    new EffectPipe(Duplex.from({ readable: b, writable: a }))] as const
}

test('T3 finite carrier refuses JSON, constructor-shaped and callback-asserted grants before state access', async () => {
  const raw = reference()
  assert.ok(T3EffectGrantReferenceSchema.safeParse(raw).success)
  for (const forged of [raw, { reference: raw, issuerOrigin: 'https://issuer.example', consume: async () => raw }]) {
    await assert.rejects(requestT3EffectAuthority('not-a-state-directory', forged as unknown as VerifiedT3EffectGrant))
    assert.throws(() => new SessionEffectAuthority('.', forged as unknown as VerifiedT3EffectGrant))
  }
  assert.throws(() => SessionEffectAuthority.fromReference({ directory: '.', authority: raw }))
  assert.throws(() => SessionEffectAuthority.fromReference({ directory: '.', authority: raw,
    issuerOrigin: 'http://issuer.example' }))
})

test('every original T3 identity and explicit native association is fixed across operations', () => {
  const first = reference()
  for (const key of ['executorId', 'environmentId', 'threadId', 'providerSessionId', 'connectionEpoch',
    'runtimeGeneration'] as const) {
    assert.equal(sameEffectSession(first, { ...first, [key]: 'different' }), false, key)
  }
  for (const key of ['driver', 'nativeId', 'continuationHomeKey', 'historyHomeKey'] as const) {
    const association: T3EffectGrantReference['nativeAssociation'] = {
      ...first.nativeAssociation, [key]: key === 'driver' ? 'claude' : 'different',
    }
    assert.equal(sameEffectSession(first, { ...first, nativeAssociation: association }), false, key)
  }
  for (const patch of [{ correlationId: 'other' }, { commandId: 'other' },
    { requestDigest: `hmac-sha256:${'c'.repeat(64)}` }]) {
    const next = { ...first, ...patch }
    assert.equal(sameEffectSession(first, next), true, 'same target still requires a new owning-route permit')
    assert.equal(sameT3EffectOperation(first, next), false, 'renewal cannot substitute another operation')
  }
})

test('T3 receiver refuses issuer substitution, expired grants and native-session retargeting', async () => {
  for (const change of ['origin', 'providerSession', 'nativeId', 'expired'] as const) {
    const [host, child] = pair()
    try {
      const scope = reference(), receiver = new EffectReceiver(child)
      host.send({ type: 'offer', seq: 1, wire: JSON.stringify({ kind: 'launch', data: '{}', scope,
        issuerOrigin: 'https://issuer.example' }) })
      await receiver.next() // Parsing alone grants no effect; no consume permit is sent.
      const next = structuredClone(scope)
      if (change === 'providerSession') next.providerSessionId = 'different'
      if (change === 'nativeId') next.nativeAssociation.nativeId = 'different'
      if (change === 'expired') {
        next.issuedAt = '2020-01-01T00:00:00.000Z'; next.expiresAt = '2020-01-01T00:00:01.000Z'
      }
      host.send({ type: 'offer', seq: 2, wire: JSON.stringify({ kind: 'input', data: 'not delivered', scope: next,
        issuerOrigin: change === 'origin' ? 'https://other.example' : 'https://issuer.example' }) })
      await assert.rejects(receiver.next())
    } finally { host.close(); child.close() }
  }
})

test('T3 receiver cannot turn signed-route revocation into a later permission', async () => {
  const [host, child] = pair()
  try {
    host.send({ type: 'offer', seq: 1, wire: JSON.stringify({ kind: 'launch', data: '{}', scope: reference(),
      issuerOrigin: 'https://issuer.example' }) })
    const receiver = new EffectReceiver(child), operation = await receiver.next()
    const refused = assert.rejects(operation.consume())
    const challenge = await host.read()
    host.send({ ...challenge, type: 'refuse' })
    await refused
    host.send({ ...challenge, type: 'permit', validUntil: Date.now() + 1_000 })
    await assert.rejects(operation.consume())
  } finally { host.close(); child.close() }
})
