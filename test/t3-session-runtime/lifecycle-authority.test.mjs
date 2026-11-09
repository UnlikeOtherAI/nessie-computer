import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Exit from 'effect/Exit'
import * as Cause from 'effect/Cause'
import * as SqlClient from 'effect/sql/SqlClient'
import { CommandId, ThreadId, RunId } from '@nessie/t3-session-source/contracts'
import { SessionLifecycleAuthority, SessionLifecycleActionRefused, withSessionLifecycleAction,
  SessionLifecycle, createSessionRuntimeLayers, Outbox, ProviderHost, NativeChildProcesses,
  LegacyImporter, Recovery, Orchestrator, ProviderSessions, Worker } from '@nessie/t3-session-source/engine'
import { withOriginalOutbox } from './outbox-fixture.mjs'

// These are synthetic owner/host services around actual original methods. They
// prove ordering and refusal, not enrolled startup or production recovery authority.
const permitted = { withAction: (_action, original) => original }
const denied = { withAction: () => Effect.fail(new SessionLifecycleActionRefused()) }
const refused = effect => Effect.result(effect).pipe(Effect.map(value => assert.equal(value._tag, 'Failure')))
const pending = id => ({ id, commandId: CommandId.make(id), threadId: ThreadId.make(id),
  request: { type: 'provider-turn.start', runId: RunId.make(`run-${id}`) } })
const row = id => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_id = ${id}`)[0]
})

test('unbound activation refuses its lifecycle owner before constructing original execution hosts', async () => {
  const runtime = createSessionRuntimeLayers()
  const result = await Effect.runPromise(Effect.exit(Effect.scoped(Layer.build(runtime.layer))))
  assert.equal(Exit.isFailure(result), true)
  assert.match(Cause.pretty(result.cause), /nessie\/t3-session\/SessionLifecycleAuthority/u)
})

test('refused lifecycle action leaves every physical pending-row field unchanged', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('refused-recovery')])
    const before = yield* row('refused-recovery')
    yield* refused(withSessionLifecycleAction(denied, 'runtime-recover', outbox.reconcileAfterProcessLoss))
    assert.deepEqual(yield* row('refused-recovery'), before)
  }))
})

test('finite lifecycle wrapper preserves the actual original recovery result exactly once', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('actual-recovery')])
    let actual
    const result = yield* withSessionLifecycleAction(permitted, 'runtime-recover', outbox.reconcileAfterProcessLoss.pipe(
      Effect.tap(value => Effect.sync(() => { actual = value }))))
    assert.equal(result, actual)
    assert.deepEqual(result, { cancelled: 1, requeued: 0 })
    assert.equal((yield* row('actual-recovery')).status, 'cancelled')
  }))
})

test('an owner cannot skip the original action, retain it after return or promote its failure', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('unexecuted')])
    const before = yield* row('unexecuted')
    let escaped
    yield* refused(withSessionLifecycleAction({ withAction: (_action, original) => {
      escaped = original
      return Effect.succeed({ cancelled: 1, requeued: 0 })
    } }, 'runtime-recover', outbox.reconcileAfterProcessLoss))
    yield* refused(escaped)
    assert.deepEqual(yield* row('unexecuted'), before)
    const sql = yield* SqlClient.SqlClient
    yield* refused(withSessionLifecycleAction({ withAction: (_action, original) => original.pipe(
      Effect.catch(() => Effect.succeed(undefined))) }, 'runtime-recover',
    sql`SELECT * FROM lifecycle_nonexistent_table`))
    assert.deepEqual(yield* row('unexecuted'), before)
  }))
})

test('a lifecycle owner cannot execute its issued mutation twice', async () => {
  await withOriginalOutbox(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('one-attempt')])
    let calls = 0
    const original = Effect.sync(() => { calls++ }).pipe(Effect.andThen(outbox.reconcileAfterProcessLoss))
    yield* refused(withSessionLifecycleAction({ withAction: (_action, action) =>
      action.pipe(Effect.andThen(action)) }, 'runtime-recover', original))
    assert.equal(calls, 1)
    assert.equal((yield* row('one-attempt')).status, 'cancelled')
  }))
})

test('an early owner return cannot detach an original SQL transaction or its interrupted cleanup', async () => {
  const entered = Promise.withResolvers(), cleaning = Promise.withResolvers(), finish = Promise.withResolvers()
  let drained = false
  const work = withOriginalOutbox(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient, outbox = yield* Outbox.EffectOutboxV2
    const original = sql.withTransaction(outbox.enqueue([pending('detached-recovery')]).pipe(
      Effect.andThen(Effect.sync(() => entered.resolve())), Effect.andThen(Effect.never),
      Effect.ensuring(Effect.promise(async () => { cleaning.resolve(); await finish.promise }))))
    const early = { withAction: (_action, action) => Effect.gen(function* () {
      yield* action.pipe(Effect.result, Effect.forkDetach)
      yield* Effect.promise(() => entered.promise)
      return undefined
    }) }
    yield* refused(withSessionLifecycleAction(early, 'runtime-recover', original))
    assert.equal(yield* row('detached-recovery'), undefined, 'the actual transaction must roll back before closure')
  })).then(() => { drained = true })
  await cleaning.promise
  assert.equal(drained, false)
  finish.resolve()
  await work
  assert.equal(drained, true)
})

test('startup refusal still shuts down providers while unadmitted shutdown SQL remains untouched', async () => {
  const mutations = [], actions = []
  const mutation = label => Effect.sync(() => { mutations.push(label) })
  const services = Layer.mergeAll(
    Layer.succeed(SessionLifecycleAuthority, { withAction: action => {
      actions.push(action); return Effect.fail(new SessionLifecycleActionRefused())
    } }),
    Layer.succeed(ProviderHost.ProviderHost, {}),
    Layer.succeed(NativeChildProcesses.ChildProcessSpawner, {}),
    Layer.succeed(LegacyImporter.LegacyV1ThreadImporter, { reconcileShells: mutation('legacy') }),
    Layer.succeed(Recovery.ProviderRuntimeRecoveryService, { recover: mutation('recover'),
      prepareForShutdown: mutation('prepare-shutdown'), reconcile: () => mutation('reconcile-shutdown') }),
    Layer.succeed(Orchestrator.OrchestratorV2, { recoverDelegatedTasks: mutation('delegated') }),
    Layer.succeed(ProviderSessions.ProviderSessionManagerV2, { shutdown: mutation('provider-close') }),
    Layer.succeed(Worker.OrchestrationEffectWorkerV2, {}),
  )
  const result = await Effect.runPromise(Effect.exit(Effect.scoped(
    Layer.build(SessionLifecycle.sessionLifecycleLayer).pipe(Effect.provide(services)))))
  assert.equal(Exit.isFailure(result), true)
  assert.deepEqual(actions, ['legacy-shell-reconcile', 'prepare-shutdown'])
  assert.deepEqual(mutations, ['provider-close'])
})
