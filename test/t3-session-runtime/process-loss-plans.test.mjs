import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/sql/SqlClient'
import { Outbox } from '@nessie/t3-session-source/engine'
import { T3ExecutionProcessLossObservationSchema } from '@nessie/executor-protocol'
import { withOriginalOutbox as fixture } from './outbox-fixture.mjs'

// Actual original SQL and scoped plans. No candidate or synthetic deadline in
// this fixture is an enrolled recovery, command, provider or source permission.
const data = JSON.parse(await readFile(new URL('./fixtures/process-loss-plan.json', import.meta.url), 'utf8'))
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id COLLATE BINARY`).map(r => ({ ...r }))
})
const seed = values => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const value of values) {
    const columns = Object.keys(value)
    yield* sql.unsafe(`INSERT INTO orchestration_v2_effect_outbox (${columns.join(',')})
      VALUES (${columns.map(() => '?').join(',')})`, columns.map(c => value[c]))
  }
})
const deadline = (candidate, duration = 2000) => {
  const remaining = Math.min(duration, candidate.observedAtMs + 4500 - Date.now())
  return { notAfterMs: Date.now() + remaining, notAfterMonotonicMs: performance.now() + remaining }
}
const failed = effect => Effect.result(effect).pipe(Effect.map(r => assert.equal(r._tag, 'Failure')))

test('the original readonly plan matches the independent native fixture across every physical field', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const before = yield* rows, plan = yield* outbox.prepareProcessLoss
    assert.deepEqual(yield* rows, before)
    assert.deepEqual([...Outbox.PROCESS_BOUND_EFFECT_TYPES], data.processBoundTypes)
    assert.deepEqual([...Outbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS], data.replaySafeTypes)
    assert.equal(plan.planDigest, data.planDigest)
    assert.deepEqual(plan.effects.map(e => e.rowDigest), data.rowDigests)
    assert.deepEqual(plan.effects.map(e => e.transition), ['cancel', 'requeue'])
    assert.ok(plan.effects.every(e => !JSON.stringify(e).includes('PRIVATE_')))
    const escaped = plan.effects
    assert.throws(() => { escaped[0].commandId = 'substitution' }, TypeError)
    escaped.splice(0, 1)
    assert.equal(plan.effects.length, 2)
    const cap = deadline(plan)
    assert.deepEqual(yield* outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }), data.expected)
    assert.deepEqual((yield* rows).map(r => r.status), ['cancelled', 'pending'])
    assert.throws(() => plan.planDigest, /process-loss-plan-closed/u)
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }))
  }))
})

test('empty global plans are observed explicitly and cannot hide a newly eligible row', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2, empty = yield* outbox.prepareProcessLoss
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify([
      'nessie.t3.process-loss-plan.v1', [],
    ])).digest('hex')
    assert.equal(empty.planDigest, expected)
    assert.deepEqual(empty.effects, [])
    assert.deepEqual(yield* outbox.reconcilePreparedProcessLoss({ candidate: empty, ...deadline(empty) }),
      { cancelled: 0, requeued: 0 })
    const stale = yield* outbox.prepareProcessLoss, cap = deadline(stale)
    yield* seed([data.rows[0]])
    const before = yield* rows
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: stale, ...cap }))
    assert.deepEqual(yield* rows, before)
  }))
})

test('full-set matching refuses added, removed and changed input rows without partially recovering any row', async () => {
  for (const mode of ['add', 'remove', 'payload', 'lease', 'status']) await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const plan = yield* outbox.prepareProcessLoss, cap = deadline(plan)
    if (mode === 'add') yield* seed([{ ...data.rows[0], effect_id: 'another', thread_id: 'foreign-thread' }])
    if (mode === 'remove') yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_id = ${data.rows[1].effect_id}`
    if (mode === 'payload') yield* sql`UPDATE orchestration_v2_effect_outbox SET payload_json = 'changed'`
    if (mode === 'lease') yield* sql`UPDATE orchestration_v2_effect_outbox SET lease_expires_at = NULL`
    if (mode === 'status') yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`
    const before = yield* rows
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, before)
  }))
})

test('unaffected rows remain outside the plan while eligible work in every thread stays inside it', async () => {
  await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed([...data.rows, { ...data.rows[1], effect_id: 'unaffected', status: 'pending' }])
    const plan = yield* outbox.prepareProcessLoss
    assert.equal(plan.planDigest, data.planDigest)
    yield* sql`UPDATE orchestration_v2_effect_outbox SET last_error = 'unaffected-change' WHERE effect_id = 'unaffected'`
    assert.deepEqual(yield* outbox.reconcilePreparedProcessLoss({ candidate: plan, ...deadline(plan) }), data.expected)
    assert.deepEqual((yield* rows).map(r => r.status), ['cancelled', 'pending', 'pending'])
  }))
})

test('closed, copied and foreign-outbox plans cannot perform the conditional transaction', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const closed = yield* Effect.scoped(outbox.prepareProcessLoss), plan = yield* outbox.prepareProcessLoss
    const cap = deadline(plan), before = yield* rows
    const context = yield* Layer.build(Layer.fresh(Outbox.layer))
    const other = yield* Outbox.EffectOutboxV2.pipe(Effect.provide(context))
    for (const candidate of [closed, { ...plan }, Object.create(Object.getPrototypeOf(plan))]) {
      yield* failed(outbox.reconcilePreparedProcessLoss({ candidate, ...cap }))
    }
    yield* failed(other.reconcilePreparedProcessLoss({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, before)
  }))
})

test('schema changes and triggers refuse before either original UPDATE can run', async () => {
  for (const mode of ['column', 'trigger']) await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const plan = yield* outbox.prepareProcessLoss, cap = deadline(plan)
    if (mode === 'column') yield* sql`ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN hidden_input TEXT`
    else {
      yield* sql`CREATE TABLE plan_canary (value TEXT)`
      yield* sql`CREATE TRIGGER plan_trigger AFTER UPDATE ON orchestration_v2_effect_outbox
        BEGIN INSERT INTO plan_canary VALUES ('unexpected'); END`
    }
    const before = yield* rows
    yield* failed(outbox.prepareProcessLoss)
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, before)
    if (mode === 'trigger') assert.deepEqual(yield* sql`SELECT * FROM plan_canary`, [])
  }))
})

test('foreign-key cascades and writer-local TEMP triggers cannot mutate rows outside the planned outbox', async () => {
  for (const mode of ['foreign-key', 'temporary-trigger']) await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const plan = yield* outbox.prepareProcessLoss, cap = deadline(plan)
    if (mode === 'foreign-key') {
      yield* sql`CREATE UNIQUE INDEX status_reference ON orchestration_v2_effect_outbox(status)`
      yield* sql`CREATE TABLE outside_recovery (status TEXT REFERENCES
        ORCHESTRATION_V2_EFFECT_OUTBOX(status) ON UPDATE CASCADE)`
      yield* sql`INSERT INTO outside_recovery VALUES ('pending')`
      yield* failed(outbox.prepareProcessLoss)
    } else {
      yield* sql`CREATE TABLE plan_temp_canary (value TEXT)`
      yield* sql`CREATE TEMP TRIGGER plan_temp_trigger AFTER UPDATE ON main.orchestration_v2_effect_outbox
        BEGIN INSERT INTO plan_temp_canary VALUES ('unexpected'); END`
    }
    const before = yield* rows
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, before)
    if (mode === 'foreign-key') assert.equal((yield* sql`SELECT status FROM outside_recovery`)[0].status, 'pending')
    else assert.deepEqual(yield* sql`SELECT * FROM plan_temp_canary`, [])
  }))
})

test('absolute and monotonic expiry after writer-lock waits refuse the complete transition', async () => {
  for (const mode of ['wall', 'monotonic']) await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const plan = yield* outbox.prepareProcessLoss, before = yield* rows, cap = deadline(plan)
    const entered = yield* Deferred.make(), release = yield* Deferred.make()
    const holder = yield* sql.withTransaction(Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release)
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    if (mode === 'wall') cap.notAfterMs = Date.now() + 100
    else cap.notAfterMonotonicMs = performance.now() + 100
    const work = yield* outbox.reconcilePreparedProcessLoss({ candidate: plan, ...cap }).pipe(
      Effect.result, Effect.forkScoped)
    yield* Effect.sleep('200 millis')
    yield* Deferred.succeed(release, undefined); yield* Fiber.join(holder)
    assert.equal((yield* Fiber.join(work))._tag, 'Failure')
    assert.deepEqual(yield* rows, before)
  }))
})

test('closing the preparing Scope interrupts and joins a waiting transaction instead of detaching SQL', async () => {
  await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const owner = yield* Scope.make()
    const plan = yield* outbox.prepareProcessLoss.pipe(Effect.provideService(Scope.Scope, owner))
    const before = yield* rows, entered = yield* Deferred.make(), release = yield* Deferred.make()
    const holder = yield* sql.withTransaction(Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release)
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const work = yield* outbox.reconcilePreparedProcessLoss({ candidate: plan, ...deadline(plan) }).pipe(
      Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Scope.close(owner, Exit.void)
    yield* Deferred.succeed(release, undefined); yield* Fiber.join(holder)
    assert.equal(Exit.isFailure(yield* Fiber.await(work)), true)
    assert.deepEqual(yield* rows, before)
  }))
})

test('oversized snapshots and deadlines beyond the original observation cap refuse without a partial plan', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* seed(data.rows)
    const plan = yield* outbox.prepareProcessLoss, before = yield* rows
    yield* failed(outbox.reconcilePreparedProcessLoss({ candidate: plan,
      notAfterMs: plan.observedAtMs + 5001, notAfterMonotonicMs: performance.now() + 2000 }))
    assert.deepEqual(yield* rows, before)
    yield* seed(Array.from({ length: 255 }, (_, i) => ({ ...data.rows[0], effect_id: 'row-' + i })))
    yield* failed(outbox.prepareProcessLoss)
  }))
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* seed([{ ...data.rows[0], payload_json: 'x'.repeat(1024 * 1024) }])
    yield* failed(outbox.prepareProcessLoss)
    assert.equal((yield* rows)[0].status, 'pending')
  }))
})

test('unsigned native observation schemas enforce exact counts and cannot parse as lifecycle grants', () => {
  const observed = { version: 1, observedAtMs: Date.now(), planDigest: data.planDigest,
    rowCount: 2, cancelled: 1, requeued: 1 }
  assert.deepEqual(T3ExecutionProcessLossObservationSchema.parse(observed), observed)
  for (const changed of [{ ...observed, requeued: 0 }, { ...observed, rowCount: 257 },
    { ...observed, domain: 'fabricated-authority' }, { ...observed, rows: data.rows }]) {
    assert.equal(T3ExecutionProcessLossObservationSchema.safeParse(changed).success, false)
  }
})
