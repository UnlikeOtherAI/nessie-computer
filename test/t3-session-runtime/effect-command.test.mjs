import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { Worker, EffectCommand, ProviderSessions, Finalization, ResourceOwners, Rollback, TurnControl,
  TurnStart, RuntimeRequests, Titles, Threads, Settings } from '@nessie/t3-session-source/engine'

const context = EffectCommand.OriginalEffectCommandContext
const row = (id, commandId, threadId) => ({ id, commandId, threadId,
  request: { type: 'provider-turn.start', runId: `run-${id}` }, status: 'running', attemptCount: 1 })

// The original executor runs over transport-only service doubles. It never
// starts a worker, claims a row or supplies native/effect authority.
const run = async (use, start) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const built = yield* Layer.build(Worker.layerExecutor.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ProviderSessions.ProviderSessionManagerV2, {}),
    Layer.succeed(Finalization.RunFinalizationService, {}),
    Layer.succeed(ResourceOwners.ResourceCleanupService, {}),
    Layer.succeed(Rollback.CheckpointRollbackServiceV2, {}),
    Layer.succeed(TurnControl.ProviderTurnControlServiceV2, {}),
    Layer.succeed(TurnStart.ProviderTurnStartServiceV2, { start }),
    Layer.succeed(RuntimeRequests.RuntimeRequestServiceV2, {}),
    Layer.succeed(Titles.ThreadTitleRegenerationService, {}),
    Layer.succeed(Threads.ThreadManagementService, {}),
    Layer.succeed(Settings.ServerSettingsService, {}),
  ))))
  return yield* use.pipe(Effect.provide(built))
})))

test('original executor supplies the exact persisted command separately from provider-turn input and clears it on return',
  async () => {
    const effect = row('durable-effect', 'actual-original-outbox-command', 'original-thread')
    let captured, startInput
    const start = input => Effect.gen(function* () {
      startInput = input
      captured = yield* context
      assert.equal(Object.isFrozen(captured), true)
      yield* Effect.yieldNow
      assert.equal(yield* context, captured)
    })
    await run(Effect.gen(function* () {
      assert.equal(yield* context, undefined)
      const executor = yield* Worker.OrchestrationEffectExecutorV2
      yield* executor.execute(effect)
      assert.equal(yield* context, undefined)
    }), start)
    assert.deepEqual(captured, { effectId: effect.id, commandId: effect.commandId,
      threadId: effect.threadId, effectType: 'provider-turn.start' })
    assert.deepEqual(startInput, { threadId: effect.threadId, runId: effect.request.runId, willRetry: false })
  })

test('concurrent original invocations retain their own command through suspension', async () => {
  const first = row('first', 'command-first', 'thread-first')
  const second = row('second', 'command-second', 'thread-second')
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  const observed = []
  const start = input => Effect.gen(function* () {
    const before = yield* context
    if (input.threadId === first.threadId) {
      entered.resolve()
      yield* Effect.promise(() => resume.promise)
    } else {
      yield* Effect.promise(() => entered.promise)
      resume.resolve()
    }
    assert.equal(yield* context, before)
    observed.push(before)
  })
  await run(Effect.gen(function* () {
    const executor = yield* Worker.OrchestrationEffectExecutorV2
    yield* Effect.all([executor.execute(first), executor.execute(second)], { concurrency: 2 })
    assert.equal(yield* context, undefined)
  }), start)
  assert.deepEqual(observed.map(value => value.commandId).sort(), ['command-first', 'command-second'])
  assert.deepEqual(observed.map(value => value.effectId).sort(), ['first', 'second'])
})

test('a nested original invocation restores the enclosing effect command after return', async () => {
  const outer = row('outer', 'outer-command', 'outer-thread')
  const inner = row('inner', 'inner-command', 'inner-thread')
  const observed = []
  const start = input => Effect.gen(function* () {
    const before = yield* context
    observed.push(before.commandId)
    if (input.threadId === outer.threadId) {
      const executor = yield* Worker.OrchestrationEffectExecutorV2
      yield* executor.execute(inner)
      assert.equal(yield* context, before)
      observed.push((yield* context).commandId)
    }
  })
  await run(Effect.gen(function* () {
    const executor = yield* Worker.OrchestrationEffectExecutorV2
    yield* executor.execute(outer)
    assert.equal(yield* context, undefined)
  }), start)
  assert.deepEqual(observed, ['outer-command', 'inner-command', 'outer-command'])
})

test('original executor failure retains metadata for cleanup without leaking it to subsequent callers', async () => {
  const effect = row('failure', 'failure-command', 'thread')
  const observed = []
  const start = () => Effect.fail(new Error('synthetic start refusal')).pipe(
    Effect.ensuring(Effect.gen(function* () { observed.push(yield* context) })))
  await run(Effect.gen(function* () {
    const executor = yield* Worker.OrchestrationEffectExecutorV2
    const result = yield* executor.execute(effect).pipe(Effect.result)
    assert.equal(result._tag, 'Failure')
    assert.equal(yield* context, undefined)
  }), start)
  assert.deepEqual(observed, [{ effectId: effect.id, commandId: effect.commandId,
    threadId: effect.threadId, effectType: 'provider-turn.start' }])
})

test('interruption keeps original effect metadata through joined cleanup and restores the caller context', async () => {
  const effect = row('cancelled', 'cancelled-command', 'thread')
  const entered = Promise.withResolvers()
  let cleaned
  const start = () => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never),
    Effect.ensuring(Effect.gen(function* () { cleaned = yield* context })))
  await run(Effect.gen(function* () {
    const executor = yield* Worker.OrchestrationEffectExecutorV2
    const fiber = yield* executor.execute(effect).pipe(Effect.forkScoped)
    yield* Effect.promise(() => entered.promise)
    yield* Fiber.interrupt(fiber)
    assert.equal(yield* context, undefined)
  }), start)
  assert.deepEqual(cleaned, { effectId: effect.id, commandId: effect.commandId,
    threadId: effect.threadId, effectType: 'provider-turn.start' })
})
