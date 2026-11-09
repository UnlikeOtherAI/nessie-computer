import assert from 'node:assert/strict'
import test from 'node:test'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as SqlClient from 'effect/sql/SqlClient'
import { ConnectionError, SqlError } from 'effect/sql/SqlError'
import { Outbox } from '@nessie/t3-session-source/engine'
import { withOriginalOutbox } from './outbox-fixture.mjs'

// Actual original SQLite/outbox interfaces. Raw rows deliberately include the
// physical legacy lease field and opaque payloads; recovery must preserve both.
// These tests confer no lifecycle, native, provider or imported-row authority.
const processBound = ['provider-turn.start', 'provider-turn.interrupt', 'provider-turn.steer',
  'provider-turn.restart', 'runtime-request.respond']
const replaySafe = ['provider-runtime.continue', 'provider-session.detach', 'provider-thread.rollback',
  'checkpoint.capture', 'scheduled-tasks.cleanup', 'terminal.cleanup', 'preview.cleanup',
  'attachment.cleanup', 'thread-title.generate', 'delegated-tasks.stop']
const seed = (id, type, status = 'running') => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO orchestration_v2_effect_outbox
    (effect_id, command_id, thread_id, effect_type, payload_json, status, attempt_count,
      available_at, lease_owner, lease_expires_at, created_at, updated_at, completed_at, last_error)
    VALUES (${id}, ${'command-' + id}, ${'thread-' + id}, ${type}, ${'{"opaque":"' + id + '"}'},
      ${status}, 3, '2026-11-01T00:00:00.000Z', 'previous-worker', '2026-11-02T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z', '2026-11-01T00:00:01.000Z', NULL, 'previous-error')`
})
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`).map(row => ({ ...row }))
})
const seedPair = seed('cancel', 'provider-turn.start').pipe(
  Effect.andThen(seed('requeue', 'terminal.cleanup')))
const failed = effect => Effect.result(effect).pipe(Effect.map(result => assert.equal(result._tag, 'Failure')))
const watch = outbox => Effect.gen(function* () {
  const entered = yield* Deferred.make(), woken = yield* Deferred.make(), observed = yield* Deferred.make()
  const fiber = yield* Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined)
    yield* outbox.awaitAvailable
    yield* Deferred.succeed(woken, undefined)
    // This fiber owns no writer transaction; the notification must expose
    // committed rows on its next actual SQL read.
    const snapshot = yield* rows
    yield* Deferred.succeed(observed, snapshot)
  }).pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  return { woken, observed, fiber }
})
const assertWaiting = observed => Effect.gen(function* () {
  yield* Effect.sleep('20 millis')
  assert.equal(yield* Deferred.isDone(observed), false)
})

test('process loss preserves the original complete global classification and every unrelated physical field', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    assert.deepEqual([...Outbox.PROCESS_BOUND_EFFECT_TYPES], processBound)
    assert.deepEqual([...Outbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS], replaySafe)
    for (const type of [...processBound, ...replaySafe, 'unrecognized-effect']) {
      for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled']) {
        yield* seed(type + ':' + status, type, status)
      }
    }
    const before = yield* rows
    const result = yield* outbox.reconcileAfterProcessLoss
    assert.deepEqual(result, { cancelled: 10, requeued: 10 })
    const after = yield* rows
    let timestamp
    for (let i = 0; i < before.length; i++) {
      const original = before[i], actual = after[i]
      const cancel = processBound.includes(original.effect_type) && ['pending', 'running'].includes(original.status)
      const requeue = replaySafe.includes(original.effect_type) && original.status === 'running'
      if (!cancel && !requeue) { assert.deepEqual(actual, original); continue }
      assert.match(actual.updated_at, /^\d{4}-\d{2}-\d{2}T/u)
      timestamp ??= actual.updated_at
      assert.equal(actual.updated_at, timestamp, 'both transitions share the original operation timestamp')
      const expected = { ...original, status: cancel ? 'cancelled' : 'pending', lease_owner: null,
        updated_at: timestamp, last_error: cancel
          ? 'Cancelled because the server process ended before the effect completed.'
          : 'Requeued after the previous server process ended.' }
      if (cancel) expected.completed_at = timestamp
      else expected.available_at = timestamp
      assert.deepEqual(actual, expected)
    }
    assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { cancelled: 0, requeued: 0 })
    assert.deepEqual(yield* rows, after)
  }))
})

test('a failure in the second original UPDATE rolls back the first UPDATE and its trigger effects', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    yield* sql`CREATE TABLE recovery_canary (effect_id TEXT)`
    yield* sql`CREATE TRIGGER record_cancellation AFTER UPDATE ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'cancel' BEGIN INSERT INTO recovery_canary VALUES (NEW.effect_id); END`
    yield* sql`CREATE TRIGGER reject_requeue BEFORE UPDATE ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'requeue' BEGIN SELECT RAISE(ABORT, 'requeue failpoint'); END`
    const before = yield* rows, observer = yield* watch(outbox)
    yield* failed(outbox.reconcileAfterProcessLoss)
    assert.deepEqual(yield* rows, before)
    assert.deepEqual(yield* sql`SELECT * FROM recovery_canary`, [])
    yield* assertWaiting(observer.woken)
  }))
})

test('nested recovery wakes the actual waiter only after the outermost durable commit', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    const observer = yield* watch(outbox)
    yield* sql.withTransaction(Effect.gen(function* () {
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { cancelled: 1, requeued: 1 })
      yield* assertWaiting(observer.woken)
    }))
    const observed = yield* Deferred.await(observer.observed)
    assert.deepEqual(observed.map(row => row.status), ['cancelled', 'pending'])
    assert.deepEqual(observed, yield* rows)
    yield* Fiber.join(observer.fiber)
  }))
})

test('an outer rollback discards both transitions and their worker notification', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    const before = yield* rows, observer = yield* watch(outbox)
    yield* failed(sql.withTransaction(outbox.reconcileAfterProcessLoss.pipe(
      Effect.andThen(Effect.fail('outer transaction failpoint')))))
    assert.deepEqual(yield* rows, before)
    yield* assertWaiting(observer.woken)
  }))
})

test('a rolled-back savepoint discards its notification even when the surrounding transaction commits', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    const before = yield* rows, observer = yield* watch(outbox)
    yield* sql.withTransaction(Effect.gen(function* () {
      yield* failed(sql.withTransaction(outbox.reconcileAfterProcessLoss.pipe(
        Effect.andThen(Effect.fail('savepoint failpoint')))))
      yield* sql`CREATE TABLE outer_commit_canary (value TEXT)`
      yield* sql`INSERT INTO outer_commit_canary VALUES ('committed')`
    }))
    assert.equal((yield* sql`SELECT value FROM outer_commit_canary`)[0].value, 'committed')
    assert.deepEqual(yield* rows, before)
    yield* assertWaiting(observer.woken)
  }))
})

test('an actual deferred foreign-key failure at COMMIT rolls back recovery without notifying workers', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    assert.equal((yield* sql`PRAGMA foreign_keys`)[0].foreign_keys, 1)
    yield* sql`CREATE TABLE recovery_parent (id TEXT PRIMARY KEY)`
    yield* sql`CREATE TABLE recovery_child (parent_id TEXT REFERENCES recovery_parent(id)
      DEFERRABLE INITIALLY DEFERRED)`
    yield* sql`CREATE TRIGGER fail_recovery_commit AFTER UPDATE ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'requeue' BEGIN INSERT INTO recovery_child VALUES ('absent'); END`
    const before = yield* rows, observer = yield* watch(outbox)
    yield* failed(outbox.reconcileAfterProcessLoss)
    assert.deepEqual(yield* rows, before)
    assert.deepEqual(yield* sql`SELECT * FROM recovery_child`, [])
    yield* assertWaiting(observer.woken)
  }))
})

test('interruption before the outer commit joins rollback and never exposes a recovery wakeup', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    const before = yield* rows, observer = yield* watch(outbox), entered = yield* Deferred.make()
    const recovering = yield* sql.withTransaction(Effect.gen(function* () {
      yield* outbox.reconcileAfterProcessLoss
      yield* Deferred.succeed(entered, undefined)
      yield* Effect.never
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(recovering)
    assert.deepEqual(yield* rows, before)
    yield* assertWaiting(observer.woken)
  }))
})

test('failed COMMIT cleanup rejects reuse until the same locked connection completes its own rollback', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    yield* sql`CREATE TABLE recovery_parent (id TEXT PRIMARY KEY)`
    yield* sql`CREATE TABLE recovery_child (parent_id TEXT REFERENCES recovery_parent(id)
      DEFERRABLE INITIALLY DEFERRED)`
    yield* sql`CREATE TRIGGER fail_recovery_commit AFTER UPDATE ON orchestration_v2_effect_outbox
      WHEN NEW.effect_id = 'requeue' BEGIN INSERT INTO recovery_child VALUES ('absent'); END`
    const before = yield* rows, observer = yield* watch(outbox)
    let rollbacks = 0
    const exit = yield* Effect.exit(sql.withTransaction(Effect.gen(function* () {
      const [connection] = yield* sql.transactionService
      const execute = connection.executeUnprepared.bind(connection)
      // Fault injection at the actual connection interface, not a replacement
      // database. Recovery must retry cleanup itself; no fixture resets state.
      connection.executeUnprepared = (statement, ...args) => {
        if (statement === 'ROLLBACK' && ++rollbacks <= 2) return Effect.fail(new SqlError({
          reason: new ConnectionError({ cause: new Error('rollback transport failpoint'),
            message: 'rollback transport failpoint', operation: 'rollback' }),
        }))
        return execute(statement, ...args)
      }
      return yield* outbox.reconcileAfterProcessLoss
    })))
    assert.equal(Exit.isFailure(exit), true)
    assert.match(Cause.pretty(exit.cause), /rollback transport failpoint/u)
    assert.equal(rollbacks, 1)
    yield* failed(sql.withTransaction(rows))
    assert.equal(rollbacks, 2, 'a failed acquisition attempts exactly one cleanup before refusing SQL')
    assert.deepEqual(yield* rows, before)
    assert.equal(rollbacks, 3, 'the next acquisition cleans the same connection before running SQL')
    assert.deepEqual(yield* sql`SELECT * FROM recovery_child`, [])
    yield* assertWaiting(observer.woken)
  }))
})

test('an uncertain COMMIT result remains a failure even when SQLite already committed and needs no rollback', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    yield* seedPair
    const observer = yield* watch(outbox)
    let commits = 0
    yield* failed(sql.withTransaction(Effect.gen(function* () {
      const [connection] = yield* sql.transactionService
      const execute = connection.executeUnprepared.bind(connection)
      connection.executeUnprepared = (statement, ...args) => {
        const effect = execute(statement, ...args)
        if (statement !== 'COMMIT') return effect
        commits++
        return effect.pipe(Effect.andThen(Effect.fail(new SqlError({ reason: new ConnectionError({
          cause: new Error('uncertain committed response failpoint'),
          message: 'uncertain committed response failpoint', operation: 'commit',
        }) }))))
      }
      return yield* outbox.reconcileAfterProcessLoss
    })))
    assert.equal(commits, 1, 'uncertainty never retries the transaction')
    assert.deepEqual((yield* rows).map(row => row.status), ['cancelled', 'pending'])
    yield* assertWaiting(observer.woken)
  }))
})
