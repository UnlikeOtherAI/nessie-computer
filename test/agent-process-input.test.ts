import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createAgentProcessInput } from '../src/coding-session/agent-process-input.js'
import { CodexAppConnection } from '../src/coding-session/codex-app-connection.js'
import { SessionEffectAuthority } from '../src/coding-session/session-effect-authority.js'
import { SessionRequestBook } from '../src/coding-session/session-request-book.js'

const pipe = () => {
  const writes: string[] = []
  const callbacks: ((error?: Error | null) => void)[] = []
  const child = new ChildProcess()
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    writes.push(String(chunk)); callbacks.push(callback)
  } })
  child.stdin.on('error', () => undefined)
  return { child, writes, callbacks, input: createAgentProcessInput(child) }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const reply = '{"id":1,"result":{}}\n'

test('automatic reply acknowledgement waits for the pipe and orders later input and end', async () => {
  const { child, input, writes, callbacks } = pipe()
  try {
    let acknowledged = false, ended = false
    const first = input.writeProtocol(reply).then(() => { acknowledged = true })
    const next = input.write('human input\n')
    const end = input.endInput(() => { ended = true })
    await tick()
    assert.equal(acknowledged, false)
    assert.deepEqual(writes, [reply])
    callbacks[0]!()
    await first
    await tick()
    assert.equal(ended, false)
    assert.deepEqual(writes, [reply, 'human input\n'])
    callbacks[1]!()
    await next
    await end
    assert.equal(ended, true)
    await assert.rejects(input.writeProtocol(reply))
  } finally { child.stdin?.destroy() }
})

test('child exit refuses a pending reply; a late callback cannot revive the input lane', async () => {
  const { child, input, writes, callbacks } = pipe()
  try {
    const first = assert.rejects(input.writeProtocol(reply))
    const next = assert.rejects(input.write('must not write'))
    await tick()
    child.emit('exit', 1, null)
    await first
    callbacks[0]!()
    await next
    await assert.rejects(input.writeProtocol(reply))
    assert.deepEqual(writes, [reply])
  } finally { child.stdin?.destroy() }
})

test('a queued operation with an expired carrier cannot write after an automatic reply', async () => {
  const { child, input, writes, callbacks } = pipe()
  // A malformed reference cannot mint an authority. This fixture only exercises
  // refusal after a queue wait; signed issuer acceptance is a separate gate.
  assert.throws(() => SessionEffectAuthority.fromReference({ authority: {}, directory: '' }))
  try {
    const first = input.writeProtocol(reply)
    // Use the real carrier parser with a structurally valid, already-expired scope.
    const effect = new SessionEffectAuthority('.', {
      version: 1, executorId: '11111111-1111-4111-8111-111111111111',
      originalOwnerGeneration: '22222222-2222-4222-8222-222222222222',
      ownerKey: `sha256:${'a'.repeat(64)}`, commandId: '33333333-3333-4333-8333-333333333333',
      operation: 'session_start', purpose: 'control', issuedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:01.000Z', connectionEpoch: '1', authorizationRevision: 1,
      filter: {}, admissions: [],
    })
    const next = assert.rejects(input.write('expired input', effect))
    await tick()
    callbacks[0]!()
    await first
    await next
    assert.deepEqual(writes, [reply])
  } finally { child.stdin?.destroy() }
})

test('automatic reply lane refuses new provider requests', async () => {
  const { child, input, writes } = pipe()
  try {
    await assert.rejects(input.writeProtocol('{"id":1,"method":"turn/start","result":{}}\n'))
    assert.deepEqual(writes, [])
  } finally { child.stdin?.destroy() }
})

test('Codex automatic result and error replies propagate delayed acknowledgement and refusal', async () => {
  for (const errorReply of [false, true]) {
    let reject!: (error: Error) => void
    const connection = new CodexAppConnection(() => { throw new Error('must use reply lane') }, 100,
      () => new Promise<void>((_resolve, refuse) => { reject = refuse }))
    let completed = false
    const response = (errorReply ? connection.respondError(1, 'unsupported') : connection.respond(1, {}))
      .then(() => { completed = true })
    const failed = assert.rejects(response, /receiver refused/u)
    await tick()
    assert.equal(completed, false)
    reject(new Error('receiver refused'))
    await failed
    assert.equal(completed, false)
  }
})

test('withdrawal waits for its automatic reply and records uncertain delivery without replay', async () => {
  const book = new SessionRequestBook(() => undefined)
  let reject!: (error: Error) => void
  let attempts = 0
  const opened = book.open({ kind: 'command', title: 'Run fixture', command: 'fixture', decisions: ['decline'] }, {
    answer: () => undefined,
    withdraw: () => { attempts++; return new Promise<void>((_resolve, refuse) => { reject = refuse }) },
  })!
  const withdrawn = assert.rejects(book.withdraw(opened.id, 'expired', 'turn_ended'), /ack lost/u)
  assert.equal(book.get(opened.id)?.status, 'expired')
  reject(new Error('ack lost'))
  await withdrawn
  assert.equal(book.get(opened.id)?.reason, 'delivery_unknown')
  await book.withdraw(opened.id, 'expired', 'turn_ended')
  assert.equal(attempts, 1)
})
