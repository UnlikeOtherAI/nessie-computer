import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { EnvironmentResourceNotFoundError, OrchestrationV2GetShellSnapshotError }
  from '@nessie/t3-session-source/contracts'
import { ExecutorT3Request, ExecutorT3HttpRequest } from '@nessie/executor-protocol/t3-session'
import { dispatchSessionRpc, dispatchRetainedHttp } from '../../dist/t3-session/runtime/dispatch.js'

const route = { transportVersion: 1, protocolVersion: 2,
  sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
  executorId: '11111111-1111-4111-8111-111111111111', environmentId: 'opaque:environment/雪',
  connectionEpoch: '9007199254740993', runtimeGeneration: 'synthetic:held-graph',
  correlationId: 'synthetic:delivery', relayOrdinal: 9, sourceSequence: 999 }
const request = () => Schema.decodeUnknownSync(ExecutorT3Request)({ ...route,
  kind: 'request', method: 'orchestration.getThreadTitles', input: { threadIds: ['thread:雪'] } })
const signal = () => new AbortController().signal
const collect = async iterable => { const rows = []; for await (const row of iterable) rows.push(row); return rows }

test('finite dispatch preserves input identity and original result, without trusting caller sequence', async () => {
  const input = request()
  const value = { 'thread:雪': 'Synthetic title' }
  const rows = await collect(dispatchSessionRpc(input, {
    'orchestration.getThreadTitles': received => {
      assert.equal(received, input.input)
      return Effect.succeed(value)
    },
  }, signal()))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].result, value)
  assert.equal(rows[0].relayOrdinal, 0)
  assert.equal(rows[0].sourceSequence, undefined)
  assert.equal(rows[0].connectionEpoch, route.connectionEpoch)
})

test('missing slot and original typed error remain distinct from defects', async () => {
  const input = request()
  assert.equal((await collect(dispatchSessionRpc(input, {}, signal())))[0].code, 'unbound_operation')
  const error = new OrchestrationV2GetShellSnapshotError({ message: 'synthetic failure' })
  const rows = await collect(dispatchSessionRpc(input,
    { 'orchestration.getThreadTitles': () => Effect.fail(error) }, signal()))
  assert.equal(rows[0].kind, 'error')
  assert.equal(rows[0].error, error)
  await assert.rejects(collect(dispatchSessionRpc(input,
    { 'orchestration.getThreadTitles': () => Effect.die(new Error('synthetic-defect')) }, signal())),
  /synthetic-defect/u)
})

test('wrong original result and finite/stream mismatch fail before emitting a reply', async () => {
  const input = request()
  await assert.rejects(collect(dispatchSessionRpc(input,
    { 'orchestration.getThreadTitles': () => Effect.succeed({ malformed: 42 }) }, signal())),
  /T3_RUNTIME_REPLY_INVALID/u)
  await assert.rejects(collect(dispatchSessionRpc(input,
    { 'orchestration.getThreadTitles': () => Stream.empty }, signal())), /KIND_MISMATCH/u)
})

test('stream demand retains original elements and cancellation finalizes the subscription', async () => {
  const input = Schema.decodeUnknownSync(ExecutorT3Request)({ ...route, kind: 'request',
    method: 'orchestration.subscribeThread', input: { threadId: 'thread:雪' } })
  let finalized = false
  const started = Promise.withResolvers()
  const stream = Stream.concat(Stream.succeed({ kind: 'synchronized' }), Stream.unwrap(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
    started.resolve()
    return Stream.never
  })))
  const controller = new AbortController()
  const iterator = dispatchSessionRpc(input, { 'orchestration.subscribeThread': () => stream }, controller.signal)
  const first = await iterator.next()
  assert.equal(first.value.kind, 'stream')
  assert.deepEqual(first.value.result, { kind: 'synchronized' })
  const next = assert.rejects(iterator.next())
  await started.promise
  controller.abort()
  await next
  assert.equal(finalized, true)
})

test('HTTP retains original error/status and does not expose internal capture errors', async () => {
  const input = Schema.decodeUnknownSync(ExecutorT3HttpRequest)({ ...route, kind: 'http-request',
    endpoint: 'threadSnapshot', params: { threadId: 'thread:雪' },
    headers: { 'x-t3-orchestration-protocol': '2' } })
  const error = new EnvironmentResourceNotFoundError({
    code: 'not_found', reason: 'thread_not_found', traceId: 'synthetic:trace',
  })
  const rows = await collect(dispatchRetainedHttp(input, { threadSnapshot: () => Effect.fail(error) }, signal()))
  assert.equal(rows[0].kind, 'http-error')
  assert.equal(rows[0].status, 404)
  assert.equal(rows[0].body, error)
  await assert.rejects(collect(dispatchRetainedHttp(input,
    { threadSnapshot: () => Effect.fail(new Error('private capture path')) }, signal())),
  /T3_RUNTIME_HTTP_STATUS_UNBOUND/u)
})

test('already cancelled demand invokes no slot', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  await assert.rejects(collect(dispatchSessionRpc(request(), {
    'orchestration.getThreadTitles': () => { called = true; return Effect.succeed({}) },
  }, controller.signal)))
  assert.equal(called, false)
})
