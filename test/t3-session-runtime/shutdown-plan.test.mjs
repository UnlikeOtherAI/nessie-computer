import assert from 'node:assert/strict'
import test from 'node:test'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import * as Exit from 'effect/Exit'
import * as SqlClient from 'effect/sql/SqlClient'
import { EventSink, Outbox } from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread as seed, shutdownRows as rows, makeShutdownRecovery as make,
  shutdownSettings, shutdownDeadline as deadline } from './shutdown-fixture.mjs'

const failed = effect => Effect.result(effect).pipe(Effect.map(result => assert.equal(result._tag, 'Failure')))
const seedPair = seed('first').pipe(Effect.andThen(seed('second')))
const watch = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2, entered = yield* Deferred.make(), woken = yield* Deferred.make()
  yield* Deferred.succeed(entered, undefined).pipe(Effect.andThen(outbox.awaitAvailable),
    Effect.andThen(Deferred.succeed(woken, undefined)), Effect.forkScoped)
  yield* Deferred.await(entered)
  return woken
})

test('prepared shutdown: the complete original readonly shutdown plan covers every selected thread and consumes exactly once', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seedPair
    const recovery = yield* make(), plan = yield* recovery.prepareShutdownPlan
    assert.deepEqual(yield* rows, [])
    assert.deepEqual(plan.threadIds, ['first', 'second'])
    assert.deepEqual(plan.effects.map(e => [e.threadId, e.sourceRunId, e.effectId, e.commandId, e.existingRowDigest]), [
      ['first', 'run:first', 'effect:restart-continuation:run:first', 'command:restart-prepare:run:first', null],
      ['second', 'run:second', 'effect:restart-continuation:run:second', 'command:restart-prepare:run:second', null],
    ])
    assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/u)
    const escaped = plan.effects
    assert.throws(() => { escaped[0].threadId = 'foreign' }, TypeError)
    escaped.pop()
    assert.equal(plan.effects.length, 2)
    const cap = deadline(plan)
    yield* recovery.prepareForShutdownPrepared({ candidate: plan, ...cap })
    assert.deepEqual((yield* rows).map(r => [r.thread_id, r.effect_type]),
      [['first', 'provider-runtime.continue'], ['second', 'provider-runtime.continue']])
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.throws(() => plan.planDigest, /shutdown-plan/u)
    const before = yield* rows, again = yield* recovery.prepareShutdownPlan
    assert.ok(again.effects.every(e => e.existingRowDigest !== null))
    yield* recovery.prepareForShutdownPrepared({ candidate: again, ...deadline(again) })
    assert.deepEqual(yield* rows, before, 'existing original effects cannot be reset or retried')
  }))
})

test('prepared shutdown: settings, selected membership and decoded projection changes refuse the entire prepared write', async () => {
  for (const mode of ['settings', 'membership', 'projection', 'slot']) await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    let settings = shutdownSettings
    const recovery = yield* make(Effect.sync(() => settings)), plan = yield* recovery.prepareShutdownPlan
    const cap = deadline(plan), sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    if (mode === 'settings') settings = { ...settings, continueThreadsAfterServerUpdate: false }
    if (mode === 'membership') yield* seed('second')
    if (mode === 'projection') yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.title', 'changed') WHERE thread_id = 'first'`
    if (mode === 'slot') yield* outbox.enqueue([{ id: plan.effects[0].effectId, commandId: 'foreign', threadId: 'foreign',
      request: { type: 'provider-runtime.continue', sourceRunId: 'foreign' } }])
    const before = yield* rows
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, before)
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
  }))
})

test('prepared shutdown: persisted and writer-local triggers cannot turn a prepared restart insert into another mutation', async () => {
  for (const temp of ['', 'TEMP ']) await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const recovery = yield* make(), plan = yield* recovery.prepareShutdownPlan, cap = deadline(plan)
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE outside_plan (value TEXT)`
    yield* sql.unsafe(`CREATE ${temp}TRIGGER outside_insert BEFORE INSERT ON orchestration_v2_effect_outbox
      BEGIN INSERT INTO outside_plan VALUES ('unplanned'); END`)
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, [])
    assert.deepEqual(yield* sql`SELECT * FROM outside_plan`, [])
  }))
})

test('prepared shutdown: failure after an actual first insert rolls back the whole group and publishes no availability', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seedPair
    const sink = yield* EventSink.EventSinkV2, sql = yield* SqlClient.SqlClient, written = yield* Deferred.make()
    const recovery = yield* make(undefined, { ...sink, writeWithEffects: input =>
      input.effects[0].threadId === 'first' ? sink.writeWithEffects(input).pipe(
        Effect.tap(() => Deferred.succeed(written, undefined)))
        : Deferred.await(written).pipe(Effect.andThen(Effect.gen(function* () {
          assert.equal((yield* rows).length, 1)
          yield* sql.unsafe('INSERT INTO nonexistent_shutdown_target VALUES (1)')
        }))),
    })
    const plan = yield* recovery.prepareShutdownPlan, woken = yield* watch
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...deadline(plan) }))
    assert.deepEqual(yield* rows, [])
    yield* Effect.sleep('20 millis')
    assert.equal(yield* Deferred.isDone(woken), false)
  }))
})

test('prepared shutdown: expiry at the actual insert cannot commit any prepared row or notify the worker', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const sink = yield* EventSink.EventSinkV2
    const recovery = yield* make(undefined, { ...sink, writeWithEffects: input => Effect.sleep('80 millis').pipe(
      Effect.andThen(sink.writeWithEffects(input))) })
    const plan = yield* recovery.prepareShutdownPlan, woken = yield* watch
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...deadline(plan, 40) }))
    assert.deepEqual(yield* rows, [])
    assert.equal(yield* Deferred.isDone(woken), false)
  }))
})

test('prepared shutdown: an ambient transaction refuses and consumes the candidate instead of publishing before its parent commits', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const sql = yield* SqlClient.SqlClient, recovery = yield* make()
    yield* failed(sql.withTransaction(recovery.prepareShutdownPlan))
    const plan = yield* recovery.prepareShutdownPlan, cap = deadline(plan)
    yield* failed(sql.withTransaction(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap })))
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, [])
  }))
})

test('prepared shutdown: closed, copied and foreign-service candidates cannot enqueue restart work', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const recovery = yield* make(), other = yield* make(), scope = yield* Scope.make()
    const plan = yield* recovery.prepareShutdownPlan.pipe(Effect.provideService(Scope.Scope, scope)), cap = deadline(plan)
    yield* failed(other.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: { ...plan }, ...cap }))
    yield* Scope.close(scope, Exit.void)
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.deepEqual(yield* rows, [])
  }))
})

test('prepared shutdown: preparing-scope closure interrupts and joins a writer waiter before any shutdown insert',
  { timeout: 10000 }, async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const sql = yield* SqlClient.SqlClient, recovery = yield* make(), scope = yield* Scope.make()
    const plan = yield* recovery.prepareShutdownPlan.pipe(Effect.provideService(Scope.Scope, scope)), cap = deadline(plan)
    const entered = yield* Deferred.make(), release = yield* Deferred.make()
    yield* sql.withTransaction(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const waiting = yield* recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }).pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.sleep('20 millis')
    yield* Scope.close(scope, Exit.void)
    assert.equal(Exit.isFailure(yield* Fiber.join(waiting)), true)
    yield* Deferred.succeed(release, undefined)
    assert.deepEqual(yield* rows, [])
  }))
})

test('prepared shutdown: a finite deadline interrupts a masked writer wait without waiting for its lock owner',
  { timeout: 10000 }, async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const sql = yield* SqlClient.SqlClient, recovery = yield* make(), plan = yield* recovery.prepareShutdownPlan
    const cap = deadline(plan, 80), entered = yield* Deferred.make(), release = yield* Deferred.make()
    yield* sql.withTransaction(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const start = performance.now()
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: plan, ...cap }))
    assert.ok(performance.now() - start < 1000)
    yield* Deferred.succeed(release, undefined)
    assert.deepEqual(yield* rows, [])
  }))
})

test('prepared shutdown: empty selections are actual observations and cannot hide newly eligible threads', async () => {
  await withOriginalState(Effect.gen(function* () {
    const recovery = yield* make(), empty = yield* recovery.prepareShutdownPlan
    assert.deepEqual(empty.threadIds, [])
    assert.deepEqual(empty.effects, [])
    yield* recovery.prepareForShutdownPrepared({ candidate: empty, ...deadline(empty) })
    const stale = yield* recovery.prepareShutdownPlan, cap = deadline(stale)
    yield* seed('appeared')
    yield* failed(recovery.prepareForShutdownPrepared({ candidate: stale, ...cap }))
    assert.deepEqual(yield* rows, [])
  }))
})
