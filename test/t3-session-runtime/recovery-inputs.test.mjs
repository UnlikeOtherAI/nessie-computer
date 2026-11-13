import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { ProjectionStore, RecoveryInputs } from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread, makeShutdownRecovery, shutdownRows, shutdownDeadline } from './shutdown-fixture.mjs'

test('actual original projection inputs match native fixture without including another thread', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/recovery-projection-inputs.json', import.meta.url), 'utf8'))
  await withOriginalState(Effect.gen(function* () {
    yield* seedShutdownThread(fixture.threadId)
    yield* seedShutdownThread('unselected')
    const projections = yield* ProjectionStore.ProjectionStoreV2
    const actual = yield* projections.getRuntimeRecoveryProjectionWithInputs(fixture.threadId)
    assert.equal(actual.inputDigest, fixture.inputDigest)
    assert.equal(actual.projection.thread.id, fixture.threadId)
    const before = yield* projections.getRuntimeRecoveryProjection(fixture.threadId)
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = ' ' || payload_json
      WHERE thread_id = 'unselected'`
    const unrelated = yield* projections.getRuntimeRecoveryProjectionWithInputs(fixture.threadId)
    assert.equal(unrelated.inputDigest, actual.inputDigest)
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = ' ' || payload_json
      WHERE thread_id = ${fixture.threadId}`
    const changed = yield* projections.getRuntimeRecoveryProjectionWithInputs(fixture.threadId)
    assert.deepEqual(changed.projection, before, 'ordinary decoded projection behavior is unchanged')
    assert.notEqual(changed.inputDigest, actual.inputDigest, 'exact physical TEXT changes remain visible')
  }))
})

test('prepared shutdown binds physical inputs even when original decoding normalizes their bytes', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seedShutdownThread('physical-inputs')
    const service = yield* makeShutdownRecovery(), plan = yield* service.prepareShutdownPlan
    assert.equal(plan.projectionInputs.length, 1)
    assert.equal(plan.projectionInputs[0].threadId, 'physical-inputs')
    assert.ok(plan.notAfterMonotonicMs > performance.now())
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = ' ' || payload_json
      WHERE thread_id = 'physical-inputs'`
    const result = yield* service.prepareForShutdownPrepared({ candidate: plan, ...shutdownDeadline(plan) })
      .pipe(Effect.result)
    assert.equal(result._tag, 'Failure')
    assert.deepEqual(yield* shutdownRows, [])
  }))
})

test('physical recovery input metadata preserves raw ordering and refuses oversized retained values', () => {
  const base = RecoveryInputs.inputDigest('thread:雪', '{ "id": "thread:雪" }', [{ section: 'runs', payload_json: '{}' }])
  assert.notEqual(base, RecoveryInputs.inputDigest('thread:雪', '{"id":"thread:雪"}', [{ section: 'runs', payload_json: '{}' }]))
  assert.notEqual(RecoveryInputs.inputDigest('thread', '{}', [
    { section: 'runs', payload_json: '{"id":"a"}' }, { section: 'runs', payload_json: '{"id":"b"}' },
  ]), RecoveryInputs.inputDigest('thread', '{}', [
    { section: 'runs', payload_json: '{"id":"b"}' }, { section: 'runs', payload_json: '{"id":"a"}' },
  ]))
  assert.throws(() => RecoveryInputs.inputDigest('thread', 'x'.repeat(4 * 1024 * 1024), []), /T3_RECOVERY_INPUT_LIMIT/u)
  assert.throws(() => RecoveryInputs.inputDigest('thread', '{}',
    Array.from({ length: 16385 }, () => ({ section: 'runs', payload_json: '{}' }))), /T3_RECOVERY_INPUT_LIMIT/u)
})
