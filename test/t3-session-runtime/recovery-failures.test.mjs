import assert from 'node:assert/strict'
import test from 'node:test'
import * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { DEFAULT_SERVER_SETTINGS } from '@nessie/t3-session-source/contracts/settings'
import { Recovery, Settings, ProjectionStore, EventSink, IdAllocator, Outbox,
  SessionLifecycle, SessionLifecycleAuthority, SessionLifecycleActionRefused,
  LegacyImporter, Orchestrator, ProviderSessions, Worker,
} from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'

// Real original recovery, SQLite, event sink and outbox. The injected settings,
// projections and lifecycle owner are synthetic inputs, never production grants.
const settings = { ...DEFAULT_SERVER_SETTINGS, continueThreadsAfterServerUpdate: true, projectSettingsOverrides: {} }
const failure = new Error('synthetic unavailable input')
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`).map(r => ({ ...r }))
})
const seed = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2
  yield* outbox.enqueue([{ id: 'existing-effect', commandId: 'original-command', threadId: 'other-thread',
    request: { type: 'provider-turn.start', runId: 'original-run' } }])
})
const makeRecovery = (options = {}) => Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2, sink = yield* EventSink.EventSinkV2
  return yield* Recovery.make.pipe(
    Effect.provideService(Settings.ServerSettingsService, { getSettings: options.getSettings ?? Effect.succeed(settings) }),
    Effect.provideService(ProjectionStore.ProjectionStoreV2, { ...projections, ...options.projections }),
    Effect.provideService(EventSink.EventSinkV2, { ...sink, ...options.sink }),
    Effect.provide(IdAllocator.layer),
  )
})
const assertFailure = (effect, stage, threadId) => Effect.gen(function* () {
  const result = yield* Effect.result(effect)
  assert.equal(result._tag, 'Failure')
  assert.ok(result.failure instanceof Recovery.ProviderRuntimeRecoveryError)
  assert.equal(result.failure.operation, stage)
  if (threadId !== undefined) assert.equal(result.failure.threadId, threadId)
})
const projection = id => {
  const at = DateTime.makeUnsafe('2026-11-01T00:00:00.000Z')
  return { thread: { id, projectId: 'project', providerInstanceId: 'instance', archivedAt: null,
    deletedAt: null, settledOverride: null },
  runs: [{ id: `run-${id}`, status: 'running', providerInstanceId: 'instance', providerThreadId: `provider-${id}`,
    startedAt: at, requestedAt: at, activeAttemptId: `attempt-${id}` }],
  providerThreads: [{ id: `provider-${id}`, appThreadId: id, ownerNodeId: null, providerInstanceId: 'instance',
    driver: 'codex', providerSessionId: `session-${id}`, status: 'active',
    nativeThreadRef: { nativeId: `native-${id}`, strength: 'strong', driver: 'codex' } }],
  providerSessions: [{ id: `session-${id}`, providerInstanceId: 'instance', driver: 'codex', status: 'ready' }],
  providerTurns: [{ id: `turn-${id}`, providerThreadId: `provider-${id}`, runAttemptId: `attempt-${id}`,
    status: 'running' }], runtimeRequests: [], turnItems: [] }
}
const selected = ids => ({ getRecoveryThreadIds: () => Effect.succeed(ids),
  getRuntimeRecoveryProjection: id => Effect.succeed(projection(id)) })

test('unavailable settings refuse startup, shutdown reconciliation and preparation before any projection or SQL mutation', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed
    const before = yield* snapshot
    let reads = 0
    const recovery = yield* makeRecovery({ getSettings: Effect.fail(failure), projections: {
      getRecoveryThreadIds: () => Effect.sync(() => { reads++; return [] }),
    } })
    for (const action of [recovery.recover, recovery.reconcile('shutdown'), recovery.prepareForShutdown]) {
      yield* assertFailure(action, 'read-settings')
      assert.deepEqual(yield* snapshot, before)
    }
    assert.equal(reads, 0)
  }))
})

test('actual disabled and empty selections still succeed without creating a restart continuation', async () => {
  await withOriginalState(Effect.gen(function* () {
    let reads = 0
    const disabled = yield* makeRecovery({ getSettings: Effect.succeed({ ...settings,
      continueThreadsAfterServerUpdate: false }), projections: {
      getRecoveryThreadIds: () => Effect.sync(() => { reads++; return ['must-not-read'] }),
    } })
    yield* disabled.prepareForShutdown
    assert.equal(reads, 0)
    const empty = yield* makeRecovery({ projections: selected([]) })
    yield* empty.prepareForShutdown
    assert.deepEqual(yield* snapshot, [])
  }))
})

test('the original project policy and restart planner persist only eligible continuations with their exact original IDs', async () => {
  await withOriginalState(Effect.gen(function* () {
    const recovery = yield* makeRecovery({ projections: { ...selected(['eligible', 'disabled', 'settled']),
      getRuntimeRecoveryProjection: id => Effect.succeed({ ...projection(id),
        thread: { ...projection(id).thread, projectId: id, settledOverride: id === 'settled' ? 'settled' : null } }),
    }, getSettings: Effect.succeed({ ...settings, projectSettingsOverrides: {
      disabled: { continueThreadsAfterServerUpdate: false },
    } }) })
    yield* recovery.prepareForShutdown
    const rows = yield* snapshot
    assert.equal(rows.length, 1)
    assert.equal(rows[0].effect_id, 'effect:restart-continuation:run-eligible')
    assert.equal(rows[0].command_id, 'command:restart-prepare:run-eligible')
    assert.equal(rows[0].thread_id, 'eligible')
    assert.equal(rows[0].effect_type, 'provider-runtime.continue')
    assert.deepEqual(JSON.parse(rows[0].payload_json), { type: 'provider-runtime.continue', sourceRunId: 'run-eligible' })
    yield* recovery.prepareForShutdown
    assert.deepEqual(yield* snapshot, rows, 'the original deterministic enqueue remains idempotent')
  }))
})

test('a failed selected projection cannot become a successful no-work shutdown preparation', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed
    const before = yield* snapshot
    const recovery = yield* makeRecovery({ projections: { ...selected(['unreadable']),
      getRuntimeRecoveryProjection: () => Effect.fail(failure),
    } })
    yield* assertFailure(recovery.prepareForShutdown, 'reconcile', 'unreadable')
    assert.deepEqual(yield* snapshot, before)
  }))
})

test('a defective selected projection stays failed rather than being logged as completed preparation', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed
    const before = yield* snapshot
    const recovery = yield* makeRecovery({ projections: { ...selected(['defective']),
      getRuntimeRecoveryProjection: () => Effect.die(failure),
    } })
    const result = yield* Effect.exit(recovery.prepareForShutdown)
    assert.equal(Exit.isFailure(result), true)
    assert.match(Cause.pretty(result.cause), /synthetic unavailable input/u)
    assert.deepEqual(yield* snapshot, before)
  }))
})

test('actual restart-enqueue SQL failure is retained with its thread and leaves the original rows unchanged', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed
    const before = yield* snapshot, sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`CREATE TRIGGER refuse_restart BEFORE INSERT ON orchestration_v2_effect_outbox
      WHEN NEW.effect_type = 'provider-runtime.continue' BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`)
    const recovery = yield* makeRecovery({ projections: selected(['refused']) })
    yield* assertFailure(recovery.prepareForShutdown, 'reconcile', 'refused')
    assert.deepEqual(yield* snapshot, before)
  }))
})

test('restart preparation joins its interrupted concurrent SQL transaction before returning the first failure',
  { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), cleaning = Promise.withResolvers(), finish = Promise.withResolvers()
  let returned = false
  const work = withOriginalState(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, sink = yield* EventSink.EventSinkV2
    const recovery = yield* makeRecovery({ projections: selected(['refused', 'inflight']), sink: {
      writeWithEffects: input => input.effects[0].threadId === 'refused'
        ? Effect.promise(() => entered.promise).pipe(Effect.andThen(Effect.fail(failure)))
        : sql.withTransaction(sink.writeWithEffects(input).pipe(
          Effect.andThen(Effect.sync(() => entered.resolve())), Effect.andThen(Effect.never),
          Effect.ensuring(Effect.promise(async () => { cleaning.resolve(); await finish.promise })))),
    } })
    yield* assertFailure(recovery.prepareForShutdown, 'reconcile', 'refused')
    assert.deepEqual(yield* snapshot, [])
  })).then(() => { returned = true })
  await cleaning.promise
  assert.equal(returned, false)
  finish.resolve()
  await work
  assert.equal(returned, true)
})

test('lifecycle shutdown retains an actual preparation failure, closes providers and skips subsequent reconciliation', async () => {
  await withOriginalState(Effect.gen(function* () {
    const recovery = yield* makeRecovery({ getSettings: Effect.fail(failure) })
    const actions = [], cleanup = []
    const services = Layer.mergeAll(
      Layer.succeed(SessionLifecycleAuthority, { withAction: (action, original) => {
        actions.push(action); return original
      }, withLegacyShellReconciliation: () => {
        actions.push('legacy-shell-reconcile'); return Effect.fail(new SessionLifecycleActionRefused())
      }, withShutdownPreparation: () => Effect.sync(() => assert.fail('failed planning must precede authority')) }),
      Layer.succeed(LegacyImporter.LegacyV1ThreadImporter, { prepareShellReconciliation: Effect.succeed(Object.freeze({})),
        reconcileShellsPrepared: () => Effect.die('unadmitted legacy writer') }),
      Layer.succeed(Recovery.ProviderRuntimeRecoveryService, recovery),
      Layer.succeed(Orchestrator.OrchestratorV2, { recoverDelegatedTasks: Effect.void }),
      Layer.succeed(ProviderSessions.ProviderSessionManagerV2, { shutdown: Effect.sync(() => cleanup.push('closed')) }),
      Layer.succeed(Worker.OrchestrationEffectWorkerV2, {}),
    )
    const result = yield* Effect.exit(Effect.scoped(Layer.build(SessionLifecycle.sessionLifecycleLayer).pipe(
      Effect.provide(services))))
    assert.equal(Exit.isFailure(result), true)
    assert.match(Cause.pretty(result.cause), /SessionLifecycleError/u)
    assert.deepEqual(actions, ['legacy-shell-reconcile'])
    assert.deepEqual(cleanup, ['closed'])
  }))
})
