import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough, Writable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { encodeProtectedFrame, ProtectedT3Process } from '../src/t3-protected-stream.js'

// Transport fixtures are not kernel custody or installed creator evidence.
function fixture(mode: 'companion' | 'finite' = 'companion') {
  const received: Record<string, unknown>[] = []
  const output = new PassThrough()
  let disposed = false
  const input = new Writable({ write(bytes: Buffer, _encoding, callback) {
    assert.equal(bytes.readUInt32LE(0), bytes.length - 4)
    received.push(JSON.parse(bytes.subarray(4).toString()) as Record<string, unknown>)
    callback()
  } })
  const child = new ProtectedT3Process({ input, output, dispose: () => { disposed = true } }, frame => {
    assert.equal(frame.kind, 'ready')
    return 42
  }, mode)
  const send = (frame: Record<string, unknown>) => output.write(encodeProtectedFrame(frame))
  send({ kind: 'ready' })
  return { child, received, send, output, get disposed() { return disposed } }
}

test('finite provider transport refuses raw Writable bytes before sending stdin', async () => {
  const f = fixture('finite')
  await f.child.ready
  const error = await new Promise<Error | null | undefined>(resolve => f.child.stdin.write('arbitrary\n', resolve))
  assert.match(error?.message ?? '', /T3_NATIVE_DELIVERY_UNKNOWN/u)
  assert.equal(f.received.some(frame => frame.kind === 'stdin'), false)
  f.send({ kind: 'closed', cleared: true })
  await f.child.closed
})

test('finite frame call awaits exact acknowledgement and rejects exit without clearance', async () => {
  const f = fixture('finite')
  await f.child.ready
  let settled = false
  const operation = f.child.requestFrame({ operation: 'commit', admission: {} })
  void operation.then(() => { settled = true }, () => undefined)
  await setImmediate()
  assert.equal(settled, false)
  f.send({ kind: 'exit', code: 0 })
  f.output.end()
  await assert.rejects(operation, /T3_NATIVE_DELIVERY_UNKNOWN/u)
  await assert.rejects(f.child.closed, /T3_NATIVE_DELIVERY_UNKNOWN/u)
  assert.equal(settled, false)
})

test('native Writable callback waits for exact protected write acknowledgement', async () => {
  const f = fixture()
  await f.child.ready
  let completed = false
  f.child.stdin.write(Buffer.from([0xf0, 0x9f]), () => { completed = true })
  await setImmediate()
  assert.equal(completed, false)
  assert.deepEqual(f.received, [{ kind: 'stdin', sequence: 1, data: Buffer.from([0xf0, 0x9f]).toString('base64') }])
  f.send({ kind: 'written', sequence: 1 })
  await setImmediate()
  assert.equal(completed, true)
  f.send({ kind: 'closed', cleared: true })
  await f.child.closed
})

test('byte frames preserve fragmented UTF8 and split transport headers', async () => {
  const f = fixture()
  await f.child.ready
  const chunks: Buffer[] = []
  f.child.stdout.on('data', (bytes: Buffer) => chunks.push(bytes))
  const expected = Buffer.from('雪🙂')
  for (const part of [expected.subarray(0, 2), expected.subarray(2, 5), expected.subarray(5)]) {
    const frame = encodeProtectedFrame({ kind: 'stdout', data: part.toString('base64') })
    for (const byte of frame) f.output.write(Buffer.from([byte]))
  }
  f.send({ kind: 'closed', cleared: true })
  await f.child.closed
  assert.deepEqual(Buffer.concat(chunks), expected)
})

test('exit is not positive service clearance', async () => {
  const f = fixture()
  await f.child.ready
  let cleared = false
  void f.child.closed.then(() => { cleared = true }, () => undefined)
  f.send({ kind: 'exit', code: 0 })
  await setImmediate()
  assert.equal(cleared, false)
  f.output.end()
  await assert.rejects(f.child.closed, /T3_NATIVE_DELIVERY_UNKNOWN/u)
})

test('stop waits for service proof and a missing or late ACK is never retried', async () => {
  const f = fixture()
  await f.child.ready
  f.child.stdin.write('input', () => undefined)
  const stop = f.child.terminate()
  await setImmediate()
  assert.equal(f.received.filter(frame => frame.kind === 'stdin').length, 1)
  assert.equal(f.received.filter(frame => frame.kind === 'stop').length, 1)
  // Even a true clearance cannot acknowledge an unknown byte delivery.
  f.send({ kind: 'closed', cleared: true })
  await assert.rejects(stop, /T3_NATIVE_DELIVERY_UNKNOWN/u)
  f.send({ kind: 'written', sequence: 1 })
  assert.equal(f.received.filter(frame => frame.kind === 'stdin').length, 1)
  assert.equal(f.disposed, true)
})

test('wrong acknowledgement sequence and false clearance are rejected', async () => {
  for (const frame of [{ kind: 'written', sequence: 2 }, { kind: 'closed', cleared: false }]) {
    const f = fixture()
    await f.child.ready
    f.child.stdin.write('input', () => undefined)
    f.send(frame)
    await assert.rejects(f.child.closed, /T3_NATIVE_DELIVERY_UNKNOWN/u)
  }
})

test('revocation drains accepted output while waiting for actual clearance', async () => {
  const f = fixture()
  await f.child.ready
  f.send({ kind: 'stdout', data: Buffer.alloc(16_384, 1).toString('base64') })
  const stop = f.child.terminate()
  f.send({ kind: 'closed', cleared: true })
  await stop
  assert.equal(f.received.at(-1)?.kind, 'stop')
})
