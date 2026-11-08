import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { sessionDispatchScope } from '../../dist/t3-session/runtime/dispatch-scope.js'

const fixture = async () => {
  const owner = await Effect.runPromise(Scope.make())
  const bind = await Effect.runPromise(sessionDispatchScope.pipe(Effect.provideService(Scope.Scope, owner)))
  return { bind, close: () => Effect.runPromise(Scope.close(owner, Exit.void)) }
}

test('owner shutdown interrupts and joins pending demand before releasing graph resources', async () => {
  const f = await fixture()
  const started = Promise.withResolvers()
  let finalized = false
  const demand = f.bind(async function* (signal) {
    try {
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      signal.throwIfAborted()
    } finally { finalized = true }
  }, new AbortController().signal)
  const stopped = assert.rejects(demand.next())
  await started.promise
  await f.close()
  await stopped
  assert.equal(finalized, true)
  await assert.rejects(demand.next(), /OPERATION_SCOPE_CLOSED/u)
})

test('iterator return cancels a blocked pull; caller cancellation also closes idle yielded demand', async () => {
  const f = await fixture()
  const started = Promise.withResolvers()
  let finalized = 0
  const first = f.bind(async function* (signal) {
    try {
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      signal.throwIfAborted()
    } finally { finalized++ }
  }, new AbortController().signal)
  const pending = assert.rejects(first.next())
  await started.promise
  await first.return()
  await pending
  const caller = new AbortController()
  const second = f.bind(async function* () {
    try { yield { synthetic: 'not a codec fixture' } } finally { finalized++ }
  }, caller.signal)
  await second.next()
  caller.abort()
  await second.return()
  assert.equal(finalized, 2)
  await f.close()
})

test('close failures remain failures and concurrent pulls are refused without starting a second iterator', async () => {
  const f = await fixture()
  let opened = 0
  const started = Promise.withResolvers()
  const demand = f.bind(async function* (signal) {
    opened++
    try {
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    } finally { throw new Error('synthetic-close-failure') }
  }, new AbortController().signal)
  const first = assert.rejects(demand.next())
  await started.promise
  await assert.rejects(demand.next(), /CONCURRENT_DEMAND/u)
  await assert.rejects(f.close())
  await first
  assert.equal(opened, 1)
})
