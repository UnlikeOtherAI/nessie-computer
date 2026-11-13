import assert from 'node:assert/strict'
import test from 'node:test'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { DelegatedRecovery, ProjectionStore, ThreadCommandExecutor } from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'

// Original recovery and keyed locks over real SQLite. Selected read records and
// callbacks are synthetic inputs, never protected production mutation authority.
const fixture = use => withOriginalState(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2
  const locks = yield* Layer.build(ThreadCommandExecutor.layer)
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor.pipe(Effect.provide(locks))
  yield* sql`CREATE TABLE recovery_changes (id TEXT NOT NULL PRIMARY KEY)`
  const options = {
    projectionStore, threadDispatch,
    finalizeAppOwnedSubagent: () => Effect.void,
    finalizeDelegatedCompletionDelivery: () => Effect.void,
    offerDelegatedCompletionDelivery: () => Effect.void,
  }
  yield* use({ sql, options })
}))
const typedFailure = result => {
  assert.equal(result._tag, 'Failure')
  assert.ok(result.failure instanceof DelegatedRecovery.DelegatedTaskRecoveryError)
  return result.failure
}

test('delegated recovery retains failed SQL selection and never enters later delivery', async () => {
  await fixture(({ sql, options }) => Effect.gen(function* () {
    let later = false
    const result = yield* DelegatedRecovery.make({ ...options, projectionStore: {
      ...options.projectionStore,
      getRecoveryThreadIds: kind => kind === 'subagent-results'
        ? sql`SELECT id FROM missing_recovery_selection`.pipe(Effect.as([]))
        : Effect.sync(() => { later = true; return [] }),
    } }).pipe(Effect.result)
    typedFailure(result)
    assert.equal(later, false)
    assert.equal((yield* sql`SELECT * FROM recovery_changes`).length, 0)
  }))
})

test('delegated recovery interrupts and joins another child transaction after one child fails', async () => {
  await fixture(({ sql, options }) => Effect.gen(function* () {
    const started = yield* Deferred.make()
    let joined = false, later = false
    const failure = new Error('synthetic refused child result')
    const result = yield* DelegatedRecovery.make({ ...options, projectionStore: {
      ...options.projectionStore,
      getRecoveryThreadIds: kind => kind === 'subagent-results' ? Effect.succeed(['waiting', 'failed'])
        : Effect.sync(() => { later = true; return [] }),
      getThreadShell: id => Effect.succeed({ lineage: { parentThreadId: `parent:${id}` } }),
    }, finalizeAppOwnedSubagent: id => id === 'waiting'
      ? sql.withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO recovery_changes (id) VALUES ('must-roll-back')`
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      })).pipe(Effect.ensuring(Effect.sync(() => { joined = true })))
      : Deferred.await(started).pipe(Effect.andThen(Effect.fail(failure))),
    }).pipe(Effect.timeout(2000), Effect.result)
    assert.equal(typedFailure(result).cause, failure)
    assert.equal(joined, true)
    assert.equal(later, false)
    assert.equal((yield* sql`SELECT * FROM recovery_changes`).length, 0)
  }))
})

test('delegated recovery retains failed completion SQL and never offers the failed delivery', async () => {
  await fixture(({ sql, options }) => Effect.gen(function* () {
    let offered = false
    const result = yield* DelegatedRecovery.make({ ...options, projectionStore: {
      ...options.projectionStore,
      getRecoveryThreadIds: kind => Effect.succeed(kind === 'delegated-completions' ? ['parent'] : []),
      getThreadRecords: () => Effect.succeed({ runs: [
        { id: 'owner-run', status: 'running', userMessageId: 'owner-message',
          delegatedCompletion: { delivery: { messageId: 'delivery-message' } } },
        { id: 'delivery-run', status: 'completed', userMessageId: 'delivery-message' },
      ] }),
    }, finalizeDelegatedCompletionDelivery: () => sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO recovery_changes (id) VALUES ('must-roll-back')`
      yield* sql`SELECT * FROM missing_completion_write`
    })), offerDelegatedCompletionDelivery: () => Effect.sync(() => { offered = true }),
    }).pipe(Effect.result)
    typedFailure(result)
    assert.equal(offered, false)
    assert.equal((yield* sql`SELECT * FROM recovery_changes`).length, 0)
  }))
})

test('delegated recovery preserves original child and delivery selection, including rolled-back runs', async () => {
  await fixture(({ sql, options }) => Effect.gen(function* () {
    const completed = []
    const result = yield* DelegatedRecovery.make({ ...options, projectionStore: {
      ...options.projectionStore,
      getRecoveryThreadIds: kind => Effect.succeed(kind === 'subagent-results' ? ['child', 'root'] : ['parent']),
      getThreadShell: id => Effect.succeed({ lineage: { parentThreadId: id === 'child' ? 'parent' : null } }),
      getThreadRecords: () => Effect.succeed({ runs: [
        { id: 'owner-run', status: 'running', userMessageId: 'owner-message',
          delegatedCompletion: { delivery: { messageId: 'delivery-message' } } },
        { id: 'delivery-run', status: 'rolled_back', userMessageId: 'delivery-message' },
        { id: 'historical-run', status: 'completed', userMessageId: 'unrelated-message' },
      ] }),
    }, finalizeAppOwnedSubagent: id => sql`INSERT INTO recovery_changes (id) VALUES (${id})`.pipe(Effect.asVoid),
    finalizeDelegatedCompletionDelivery: (_thread, run) => Effect.sync(() => { completed.push(run) }),
    offerDelegatedCompletionDelivery: (thread, run) =>
      sql`INSERT INTO recovery_changes (id) VALUES (${`${thread}:${run}`})`.pipe(Effect.asVoid),
    }).pipe(Effect.result)
    assert.equal(result._tag, 'Success')
    assert.deepEqual(completed, ['delivery-run'])
    assert.deepEqual((yield* sql`SELECT id FROM recovery_changes ORDER BY id`).map(row => row.id),
      ['child', 'parent:owner-run'])
  }))
})

test('delegated recovery retains single-restart failures, original defects and cancellation', async () => {
  const original = new Error('synthetic original failure')
  const failed = await Effect.runPromise(DelegatedRecovery.retainRecoveryFailure(Effect.fail(original))
    .pipe(Effect.result))
  assert.equal(typedFailure(failed).cause, original)
  for (const work of [Effect.die(original), Effect.interrupt]) {
    const result = await Effect.runPromise(Effect.exit(DelegatedRecovery.retainRecoveryFailure(work)))
    assert.equal(Exit.isFailure(result), true)
    assert.equal(Cause.hasDies(result.cause), work === Effect.interrupt ? false : true)
    if (work === Effect.interrupt) assert.equal(Cause.hasInterruptsOnly(result.cause), true)
  }
})
