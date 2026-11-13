import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { attachRetainedParentHandoff } from '../../dist/t3-session/runtime/parent-handoff.js'
import { RetainedParentRequest, createRetainedDaemonRuntime } from '../../dist/t3-session/runtime/daemon-handoff.js'

const id = 'd18f1396-74e1-4329-bbaa-285424f1fb42'
const cancel = { version: 1, operation: 'retained-import.cancel', challengeId: id }
const fixture = accept => {
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = []
  output.on('data', chunk => replies.push(JSON.parse(chunk.toString())))
  const retired = Promise.withResolvers()
  let retirements = 0
  const channel = attachRetainedParentHandoff(input, output, accept, async () => {
    retirements++
    await retired.promise
  })
  return { input, output, replies, channel, retired, count: () => retirements }
}

test('inherited channel reconstructs fragmented finite frames and drains one retirement before close', async () => {
  const accepted = []
  const f = fixture(request => accepted.push(request))
  const frame = Buffer.from(`${JSON.stringify(cancel)}\n`)
  f.input.write(frame.subarray(0, 17))
  assert.equal(accepted.length, 0)
  f.input.write(frame.subarray(17))
  assert.deepEqual(accepted, [cancel])
  assert.deepEqual(f.replies, [{ version: 1, kind: 'retained-import', status: 'ready' }])
  let closed = false
  const closing = f.channel.close().then(() => { closed = true })
  await setImmediate()
  assert.equal(closed, false)
  assert.equal(f.count(), 1)
  f.retired.resolve()
  await closing
  await f.channel.close()
  assert.equal(f.count(), 1)
  f.input.end(); f.output.end()
})

test('unknown commands, excess properties, invalid UTF-8 and unbounded frames retire without dispatch', async () => {
  for (const frame of [Buffer.from('{"operation":"execute","argv":["cmd"]}\n'),
    Buffer.from(`${JSON.stringify({ ...cancel, path: 'arbitrary' })}\n`), Buffer.from([0xff, 10]), Buffer.alloc(4096, 65)]) {
    const f = fixture(() => assert.fail('invalid parent frame dispatched'))
    f.input.write(frame)
    await setImmediate()
    assert.equal(f.count(), 1)
    f.retired.resolve()
    await f.channel.close()
    f.input.end(); f.output.end()
  }
})

test('unexpected dispatcher failure retires without a false terminal refusal', async () => {
  const f = fixture(() => { throw new Error('outcome unknown') })
  f.input.write(`${JSON.stringify(cancel)}\n`)
  await setImmediate()
  assert.equal(f.count(), 1)
  assert.deepEqual(f.replies.map(value => value.status), ['ready'])
  f.retired.resolve()
  await f.channel.close()
  f.input.end(); f.output.end()
})

const snapshot = () => {
  const now = Date.now()
  const challenge = { version: 1, challengeId: id, nonce: Buffer.alloc(32, 3).toString('base64url'),
    requestId: id, executorId: id, environmentId: 'synthetic:environment', admittedRootKey: 'synthetic:root',
    physicalRootKey: 'windows-file-id:synthetic', databaseIdentity: 'synthetic:database', environmentIdentity: 'synthetic:identity',
    organizationId: id, teamId: id, recipient: { subject: 'synthetic:human', organizationId: 'synthetic:org', teamId: 'synthetic:team' },
    selection: { kind: 'whole_source' }, purpose: 'retained-import-read-publish', grantGeneration: id,
    captureGeneration: 'synthetic:capture', acceptedBaseline: 'not_attested_by_original_source',
    issuedAtMs: now - 1000, expiresAtMs: now + 90_000, grantExpiresAtMs: now + 80_000,
    issuerEnrollmentId: id, issuerKeyId: 'a'.repeat(64) }
  return RetainedParentRequest.parse({ version: 1, operation: 'retained-import.begin', challenge,
    expiresAtMs: now + 80_000, receipt: { version: 1, kind: 'native-source-owner-consent', challengeId: id,
      challengeDigest: 'b'.repeat(64), receiptId: 'c'.repeat(64), issuerInstance: 'd'.repeat(64),
      expiresAtMs: now + 80_000, issuerKeyId: 'a'.repeat(64), nativeSignature: 'synthetic-untrusted-signature' } })
}

test('selected grants refuse before capture; JSON alone cannot activate the actual source producer', async () => {
  const statuses = []
  const runtime = createRetainedDaemonRuntime('never-open-this-path', () => ({ executorId: id }), () => {},
    value => statuses.push(value))
  const request = snapshot()
  runtime.accept({ ...request, challenge: { ...request.challenge,
    selection: { kind: 'threads', threadIds: ['synthetic:thread'], projectIds: [] } } })
  assert.equal(statuses.pop().status, 'refused')
  assert.deepEqual(await runtime.lane.describe(), [])
  // Calls the production capture path. No machine source owner is registered,
  // so it refuses before native, network or filesystem work; no trust factory.
  runtime.accept(request)
  runtime.accept({ ...request, expiresAtMs: request.expiresAtMs - 1 })
  assert.deepEqual(statuses.map(value => value.status), ['accepted', 'accepted'])
  await setImmediate()
  assert.deepEqual(statuses.map(value => value.status), ['accepted', 'accepted', 'failed'])
  assert.deepEqual(await runtime.lane.describe(), [])
  runtime.accept(request)
  assert.equal(statuses.at(-1).status, 'failed')
  await assert.rejects(runtime.close(), /shutdown_unproved/u)
})
