import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import test from 'node:test'
import type { T3EffectGrantReference } from '@nessie/executor-protocol/t3-session'
import { AGENT_FRAME_BYTES, ProviderReplyLedger, readAgentFrame } from '../src/coding-session/agent-byte-frames.js'
import { createAgentByteTransport } from '../src/coding-session/agent-byte-transport.js'
import { EffectPipe, EffectReceiver } from '../src/coding-session/effect-channel.js'
import { attachEffectTransport, effectTransport } from '../src/coding-session/effect-transport.js'
import { createAgentProcessInput } from '../src/coding-session/agent-process-input.js'
import { SessionEffectAuthority } from '../src/coding-session/session-effect-authority.js'

test('logical frames retain bytes across every split of multibyte UTF8', () => {
  const bytes = Buffer.from('{"id":"čau雪😀", "method":"fixture"}\r\n')
  for (let split = 0; split <= bytes.length; split++) {
    const frame = readAgentFrame([bytes.subarray(0, split), bytes.subarray(split)])
    assert.deepEqual(Buffer.from(frame.text), bytes)
  }
})

test('incomplete, mixed, duplicate-key, oversized and invalid UTF8 input refuses', () => {
  for (const bytes of [Buffer.from('{"id":1}'), Buffer.from('{"id":1}\n{"id":2}\n'),
    Buffer.from('{"id":1,"\\u0069d":2}\n'), Buffer.from('{"args":{"a":1,"a":2}}\n'),
    Buffer.from('{"args":[{"a":1,"a":2}]}\n'), Buffer.from('[]\n'),
    Buffer.alloc(AGENT_FRAME_BYTES + 1), Buffer.from([123, 34, 97, 34, 58, 34, 0xff, 34, 125, 10])]) {
    assert.throws(() => readAgentFrame(bytes))
  }
  assert.doesNotThrow(() => readAgentFrame(Buffer.from('{"a":[{"a":1},{"a":2}],"b":"a"}\n')))
})

test('automatic responses consume an actual outstanding request exactly once', () => {
  const ledger = new ProviderReplyLedger('codex')
  assert.throws(() => ledger.unsupported('request'))
  const frame = Buffer.from('{"id":"čau","method":"fixture"}\n')
  for (const byte of frame) ledger.observe(Buffer.from([byte]))
  assert.throws(() => ledger.unsupported('different'))
  assert.deepEqual(JSON.parse(ledger.unsupported('čau')), {
    id: 'čau', error: { code: -32601, message: 'Unsupported provider request' },
  })
  assert.throws(() => ledger.unsupported('čau'))
  ledger.observe(Buffer.from('{"id":3,"result":{}}\n'))
  assert.throws(() => ledger.unsupported(3))
  ledger.observe(Buffer.from('{"id":4,"method":"fixture"}\n'))
  ledger.claimResponse({ id: 4, result: {} })
  assert.throws(() => ledger.unsupported(4))
  assert.throws(() => ledger.claimResponse({ id: 4, result: {} }))
})

test('ambiguous output disables only the reply observer; cancellation and numeric IDs stay exact', () => {
  const codex = new ProviderReplyLedger('codex')
  codex.observe(Buffer.from('{"id":1,"method":"fixture"}\n'))
  assert.throws(() => codex.unsupported('1'))
  codex.observe(Buffer.from('{"id":1,"method":"fixture"}\n'))
  assert.throws(() => codex.unsupported(1))
  const claude = new ProviderReplyLedger('claude')
  claude.observe(Buffer.from('{"type":"control_request","request_id":"one","request":{}}\n'))
  claude.observe(Buffer.from('{"type":"control_cancel_request","request_id":"one"}\n'))
  assert.throws(() => claude.unsupported('one'))
  claude.observe(Buffer.alloc(AGENT_FRAME_BYTES + 1, 120))
  claude.observe(Buffer.from('\n{"type":"control_request","request_id":"two"}\n'))
  assert.throws(() => claude.unsupported('two'))
})

// A synthetic pipe/receiver, not a native process or proof of an admitted signed launch.
// The launch ACK below exists only to exercise output and authority-free negative replies.
const fixture = async () => {
  const child = new ChildProcess(), outbound = new PassThrough(), inbound = new PassThrough()
  const host = Duplex.from({ readable: inbound, writable: outbound })
  const receiverPipe = new EffectPipe(Duplex.from({ readable: outbound, writable: inbound }))
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr, null, host]
  const scope: T3EffectGrantReference = {
    kind: 't3-effect', version: 1, purpose: 'execute', executorId: randomUUID(),
    environmentId: 'environment', threadId: 'thread', providerSessionId: 'provider', connectionEpoch: '1',
    runtimeGeneration: 'generation', correlationId: 'launch', commandId: 'launch',
    requestDigest: `hmac-sha256:${'a'.repeat(64)}`,
    nativeAssociation: { driver: 'codex', nativeId: 'native', continuationHomeKey: 'continuation', historyHomeKey: 'history' },
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4_000).toISOString(),
    requestNonce: randomUUID(), requestProofDigest: `sha256:${'b'.repeat(64)}`,
  }
  const reference = { directory: 'not-an-enrolled-directory', authority: scope, issuerOrigin: 'https://issuer.example' }
  attachEffectTransport(child, 4, reference, { command: 'fixture', args: [], cwd: '.' })
  const receiver = new EffectReceiver(receiverPipe)
  const launch = await receiver.next()
  launch.outcome('accepted')
  await effectTransport(child)!.ready
  const never = new Promise<never>(() => undefined)
  const process = createAgentByteTransport({ child, identity: { pid: 1 },
    exited: never, rawExit: never, closed: never, alive: () => true,
    confirmHostExecutionStopped: async () => false, stderrTail: () => [],
    write: async () => { throw new Error('Legacy input must not be used') },
    writeProtocol: async () => { throw new Error('Legacy reply must not be used') },
    endInput: async () => { throw new Error('Legacy EOF must not be used') },
  }, scope)
  return { child, process, receiver, reference, close: () => {
    receiverPipe.close(); host.destroy(); process.stdout.destroy(); process.stderr.destroy(); process.stdin.destroy()
    child.stdout?.destroy()
  } }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('SDK stdin refuses without forwarding bytes and launch authority cannot authorize input', async () => {
  const value = await fixture()
  try {
    const frame = Buffer.from('{"id":1,"method":"turn/start"}\n')
    await assert.rejects(new Promise<void>((resolve, reject) => value.process.stdin.write(frame,
      error => error ? reject(error) : resolve())), /Original operation/u)
    await assert.rejects(value.process.write(frame, SessionEffectAuthority.fromReference(value.reference)!))
    const legacy = createAgentProcessInput(value.child)
    await assert.rejects(legacy.write(frame.toString(), SessionEffectAuthority.fromReference(value.reference)!))
  } finally { value.close() }
})

test('stdout/stderr remain byte streams and automatic reply waits for receiver ACK', async () => {
  const value = await fixture()
  try {
    const output: Buffer[] = [], errors: Buffer[] = []
    value.process.stdout.on('data', chunk => output.push(Buffer.from(chunk)))
    value.process.stderr.on('data', chunk => errors.push(Buffer.from(chunk)))
    const bytes = Buffer.from('{"id":"雪","method":"fixture"}\n')
    ;(value.child.stdout as PassThrough).write(bytes.subarray(0, 9))
    ;(value.child.stdout as PassThrough).write(bytes.subarray(9))
    ;(value.child.stderr as PassThrough).write(Buffer.from([0, 0xff, 10]))
    await tick()
    assert.deepEqual(Buffer.concat(output), bytes)
    assert.deepEqual(Buffer.concat(errors), Buffer.from([0, 0xff, 10]))
    let acknowledged = false
    const pending = value.process.replyUnsupported('雪').then(() => { acknowledged = true })
    const reply = await value.receiver.next()
    await reply.consume()
    assert.equal(acknowledged, false)
    reply.outcome('accepted')
    await pending
    assert.equal(acknowledged, true)
    await assert.rejects(value.process.replyUnsupported('雪'))
  } finally { value.close() }
})

test('exit before ACK poisons queued replies and a late ACK never permits retry', async () => {
  const value = await fixture()
  try {
    value.process.stdout.resume()
    ;(value.child.stdout as PassThrough).write(Buffer.from('{"id":1,"method":"fixture"}\n'))
    await tick()
    const pending = assert.rejects(value.process.replyUnsupported(1))
    const reply = await value.receiver.next()
    value.child.emit('exit', 1, null)
    await pending
    // The peer may already be closed. A late outcome is either rejected there or ignored by the failed lane.
    try { reply.outcome('accepted') } catch { /* Closed channel also refuses the late ACK. */ }
    await assert.rejects(value.process.replyUnsupported(1))
    assert.equal(await value.process.confirmHostExecutionStopped(), false)
  } finally { value.close() }
})

test('queue count stays bounded while the first reply awaits the native outcome', async () => {
  const value = await fixture()
  try {
    value.process.stdout.resume()
    ;(value.child.stdout as PassThrough).write(Buffer.from('{"id":1,"method":"fixture"}\n'))
    await tick()
    const pending = Array.from({ length: 8 }, () => assert.rejects(value.process.replyUnsupported(1)))
    await assert.rejects(value.process.replyUnsupported(1))
    await value.receiver.next()
    value.child.emit('exit', 1, null)
    await Promise.all(pending)
  } finally { value.close() }
})

test('actual child errors are observable, poison pending input and never clear stop debt', async () => {
  const value = await fixture()
  try {
    const errors: Error[] = []
    const unsubscribe = value.process.onError(error => errors.push(error))
    value.process.stdout.resume()
    ;(value.child.stdout as PassThrough).write(Buffer.from('{"id":1,"method":"fixture"}\n'))
    await tick()
    const pending = assert.rejects(value.process.replyUnsupported(1))
    await value.receiver.next()
    const error = new Error('synthetic child failure')
    value.child.emit('error', error)
    await pending
    assert.deepEqual(errors, [error])
    unsubscribe()
    await assert.rejects(value.process.replyUnsupported(1))
    assert.equal(await value.process.confirmHostExecutionStopped(), false)
  } finally { value.close() }
})
