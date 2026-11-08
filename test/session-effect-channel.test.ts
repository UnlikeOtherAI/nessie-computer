import assert from 'node:assert/strict'
import { PassThrough, Duplex } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { automaticProviderReply, automaticTerminalReply, EffectPipe, EffectReceiver,
  sameEffectSession } from '../src/coding-session/effect-channel.js'
import type { ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'

const scope = (): ExecutorCodingSessionAuthority => ({ version: 1, executorId: randomUUID(),
  originalOwnerGeneration: randomUUID(), ownerKey: `sha256:${'a'.repeat(64)}`, commandId: randomUUID(),
  operation: 'session_start', purpose: 'control', issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5_000).toISOString(), connectionEpoch: '1', authorizationRevision: 1,
  filter: {}, admissions: [] })
const pair = () => {
  const a = new PassThrough(), b = new PassThrough()
  return [new EffectPipe(Duplex.from({ readable: a, writable: b })),
    new EffectPipe(Duplex.from({ readable: b, writable: a }))] as const
}

test('automatic responses cannot carry provider requests or terminal commands', () => {
  assert.ok(automaticProviderReply('{"id":1,"result":{}}'))
  assert.equal(automaticProviderReply('{"id":1,"method":"turn/start","result":{}}'), false)
  assert.equal(automaticProviderReply('input'), false)
  assert.ok(automaticTerminalReply('\u001b[1;2R'))
  assert.equal(automaticTerminalReply('\u001b[1;2R\ncommand'), false)
  const first = scope()
  for (const patch of [{ commandId: randomUUID() }, { connectionEpoch: '2' }, { authorizationRevision: 2 },
    { originalOwnerGeneration: randomUUID() }, { ownerKey: 'different' }]) {
    assert.equal(sameEffectSession(first, { ...first, ...patch }), false)
  }
})

test('receiver rejects substituted nonce/digest, stale permits and duplicate sequence without effects', async () => {
  for (const patch of [{ nonce: randomUUID() }, { digest: 'substituted' }, { validUntil: Date.now() - 1 }]) {
    const [host, child] = pair()
    try {
      const wire = JSON.stringify({ kind: 'launch', data: '{}', scope: scope() })
      const digest = createHash('sha256').update(wire).digest('hex')
      host.send({ type: 'offer', seq: 1, wire })
      const receiver = new EffectReceiver(child), operation = await receiver.next()
      const refused = assert.rejects(operation.consume())
      const challenge = await host.read()
      host.send({ ...challenge, type: 'permit', validUntil: Date.now() + 1_000, ...patch })
      await refused
      host.send({ type: 'offer', seq: 1, wire })
      await assert.rejects(receiver.next())
      assert.equal(challenge.digest, digest)
    } finally { host.close(); child.close() }
  }
})

test('an owning-route refusal cannot become permission through a later stale permit', async () => {
  const [host, child] = pair()
  try {
    const wire = JSON.stringify({ kind: 'launch', data: '{}', scope: scope() })
    host.send({ type: 'offer', seq: 1, wire })
    const receiver = new EffectReceiver(child), operation = await receiver.next()
    const refused = assert.rejects(operation.consume())
    const challenge = await host.read()
    host.send({ ...challenge, type: 'refuse' })
    await refused
    host.send({ ...challenge, type: 'permit', validUntil: Date.now() + 1_000 })
    // The abandoned challenge cannot satisfy a new consumption attempt.
    await assert.rejects(operation.consume())
  } finally { host.close(); child.close() }
})
