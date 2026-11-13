import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { InteractiveStreamWindow, INTERACTIVE_STREAM_LIMITS as limits } from '../../dist/t3-session/interactive/window.js'

function window(milliseconds = 30_000) {
  const controller = new AbortController()
  const stream = new InteractiveStreamWindow(controller.signal, Date.now() + milliseconds)
  return { stream, controller }
}

test('eight-frame window uses exact ordered ACKs; duplicate/skipped/future ACKs cannot increase demand', () => {
  const { stream } = window()
  try {
    for (let i = 0; i < 10; i++) stream.enqueue(new Uint8Array([i]))
    for (let i = 0; i < 8; i++) assert.equal(stream.take().ordinal, i)
    assert.equal(stream.take(), undefined)
    assert.throws(() => stream.acknowledge(1), /invalid_ack/u)
    assert.throws(() => stream.acknowledge(99), /invalid_ack/u)
    stream.acknowledge(0)
    stream.acknowledge(0)
    assert.equal(stream.take().ordinal, 8)
    assert.equal(stream.take(), undefined)
  } finally { stream.close() }
})

test('byte credit admits one bounded large snapshot and preserves source buffer ownership', () => {
  const { stream } = window()
  try {
    const bytes = new Uint8Array(limits.windowBytes + 1).fill(7)
    stream.enqueue(bytes)
    bytes.fill(1)
    stream.enqueue(new Uint8Array([9]))
    const frame = stream.take()
    assert.equal(frame.bytes[0], 7)
    assert.equal(stream.take(), undefined)
    frame.bytes.fill(2)
    stream.acknowledge(frame.ordinal)
    assert.equal(stream.take().bytes[0], 9)
  } finally { stream.close() }
})

test('oversized frames and tiny-event floods terminate explicitly; no silent empty stream', () => {
  const first = window().stream
  assert.throws(() => first.enqueue(new Uint8Array(limits.frameBytes + 1)), /stream_capacity/u)
  assert.throws(() => first.take(), /stream_capacity/u)
  const second = window().stream
  for (let i = 0; i < limits.queuedChunks; i++) second.enqueue(new Uint8Array())
  assert.throws(() => second.enqueue(new Uint8Array()), /stream_capacity/u)
  assert.throws(() => second.take(), /stream_capacity/u)
})

test('abort and idle expiry erase pending output, while cancellation never claims a PTY stopped', async () => {
  const aborted = window()
  aborted.stream.enqueue(new Uint8Array([1]))
  aborted.controller.abort()
  assert.throws(() => aborted.stream.take(), /resource_expired/u)
  const expired = window(10)
  expired.stream.enqueue(new Uint8Array([1]))
  await delay(20)
  assert.throws(() => expired.stream.take(), /resource_expired/u)
  assert.throws(() => new InteractiveStreamWindow(new AbortController().signal, Date.now() + 120_000), /resource_expired/u)
})
