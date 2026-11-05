import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireNativeControlLease } from '../src/native-control-lease.js'

const command = fileURLToPath(new URL('./fixtures/native-control-lease.mjs', import.meta.url))
const acquire = (nonce: string) => acquireNativeControlLease({ helper: process.execPath, command, nonce,
  maximumBytes: 256, parse: value => {
    assert.deepEqual(value, { version: 1, nonce })
    return value
  } })

test('a fragmented public ACK borrows a live hold until exact release and successful exit', async () => {
  const held = await acquire('success')
  held.assertLive()
  assert.deepEqual(held.value, { version: 1, nonce: 'success' })
  await held.release()
  await held.release()
  assert.throws(held.assertLive)
  await held.abort()
})

test('malformed and oversized pipe output cannot establish custody', async () => {
  await assert.rejects(acquire('invalid'))
  await assert.rejects(acquire('oversized'))
})

test('a public ACK cannot substitute for actual successful native release', async () => {
  const held = await acquire('failed-release')
  await assert.rejects(held.release())
  await held.abort()
})

test('an ACK from an exited helper never remains a live hold', async () => {
  const held = await acquire('early-close')
  try {
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.throws(held.assertLive)
    await assert.rejects(held.release())
  } finally { await held.abort() }
})

test('transport abort ends the child but does not become successful custody release', async () => {
  const held = await acquire('aborted')
  await held.abort()
  assert.throws(held.assertLive)
  await assert.rejects(held.release())
})
