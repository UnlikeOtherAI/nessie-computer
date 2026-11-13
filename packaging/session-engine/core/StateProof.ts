import assert from 'node:assert/strict'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import { CommandId, EventId, ProjectId, ProviderInstanceId, RunId, ThreadId,
  type OrchestrationV2DomainEvent } from 't3-source:packages/contracts/src/index.ts'
import * as Sqlite from 't3-source:apps/server/src/persistence/Sqlite.ts'
import { createSessionStateLayers, CommandReceipts, EventSink, Outbox, ProjectionStore,
  ORCHESTRATION_PROTOCOL_VERSION } from './StateLayers.ts'

/** Real lower engine services, synthetic in-memory SQLite only; no provider or lifecycle substitute. */
export const runSessionStateProof = () => {
  const state = createSessionStateLayers()
  const layer = state.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))
  const program = Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2
    const outbox = yield* Outbox.EffectOutboxV2
    const projection = yield* ProjectionStore.ProjectionStoreV2
    const now = yield* DateTime.now
    const event = (suffix: string, title: string): OrchestrationV2DomainEvent => {
      const threadId = ThreadId.make(`state-proof:${suffix}`)
      const instanceId = ProviderInstanceId.make('synthetic-unused-provider')
      return {
        id: EventId.make(`state-proof:${suffix}:created`), type: 'thread.created', threadId, occurredAt: now,
        payload: {
          id: threadId, projectId: ProjectId.make('state-proof:project'), title,
          createdBy: 'user', creationSource: 'web', providerInstanceId: instanceId,
          modelSelection: { instanceId, model: 'synthetic-unused-model' },
          runtimeMode: 'approval-required', interactionMode: 'default',
          branch: null, worktreePath: null, activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null,
          settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
        },
      }
    }
    const command = (suffix: string, title: string) => {
      const created = event(suffix, title)
      const commandId = CommandId.make(`state-proof:${suffix}:command`)
      return {
        commandId, threadId: created.threadId, commandType: 'thread.create', acceptedAt: now,
        events: [created], effects: [{ id: `state-proof:${suffix}:effect`, commandId,
          threadId: created.threadId,
          request: { type: 'provider-runtime.continue' as const, sourceRunId: RunId.make(`state-proof:${suffix}:run`) },
        }],
      }
    }
    const first = command('first', 'Synthetic committed thread')
    const wake = yield* Effect.forkScoped(outbox.awaitAvailable)
    const committed = yield* sink.commitCommand(first)
    yield* Fiber.join(wake).pipe(Effect.timeout('2 seconds'))
    assert.equal(committed.committed, true)
    assert.ok(committed.receipt.resultSequence > 0)
    assert.equal((yield* projection.getThread(first.threadId)).title, 'Synthetic committed thread')
    assert.equal(Option.isSome(yield* receipts.getByCommandId(first.commandId)), true)
    assert.equal((yield* outbox.listByCommandId(first.commandId)).length, 1)
    const duplicate = yield* sink.commitCommand(first)
    assert.equal(duplicate.committed, false)
    assert.equal(duplicate.receipt.resultSequence, committed.receipt.resultSequence)
    assert.equal((yield* outbox.listByCommandId(first.commandId)).length, 1)
    const duplicateWake = yield* Effect.exit(outbox.awaitAvailable.pipe(Effect.timeout('50 millis')))
    assert.equal(Exit.isFailure(duplicateWake), true)
    const replay = yield* Stream.runCollect(sink.readByCommandId({ commandId: first.commandId }))
    assert.equal(replay.length, 1)
    assert.equal(replay[0]?.sequence, committed.receipt.resultSequence)

    const next = command('rollback', 'This transaction rolls back')
    const tail = yield* Effect.forkScoped(sink.stream({ threadId: next.threadId, afterSequence: 0 })
      .pipe(Stream.take(1), Stream.runCollect))
    yield* Effect.yieldNow
    const rolledBack = yield* Effect.exit(sink.withProviderBatch(
      sink.commitCommand(next).pipe(Effect.andThen(Effect.fail('synthetic-rollback'))),
    ))
    assert.equal(Exit.isFailure(rolledBack), true)
    assert.equal(Option.isNone(yield* receipts.getByCommandId(next.commandId)), true)
    assert.equal((yield* outbox.listByCommandId(next.commandId)).length, 0)
    assert.equal(yield* projection.getThreadShell(next.threadId), null)
    assert.equal(yield* sink.latestSequence(), committed.receipt.resultSequence)

    const recovered = command('rollback', 'Committed after rollback')
    const recoveredResult = yield* sink.commitCommand(recovered)
    const live = yield* Fiber.join(tail).pipe(Effect.timeout('2 seconds'))
    assert.equal(live.length, 1)
    assert.equal(live[0]?.event.type, 'thread.created')
    const published = live[0]?.event
    assert.ok(published?.type === 'thread.created')
    assert.equal(published.payload.title, 'Committed after rollback')
    assert.equal(live[0]?.sequence, recoveredResult.receipt.resultSequence)
    assert.equal((yield* outbox.listByCommandId(recovered.commandId)).length, 1)
    const resumed = yield* sink.stream({ afterSequence: committed.receipt.resultSequence })
      .pipe(Stream.take(1), Stream.runCollect, Effect.timeout('2 seconds'))
    assert.equal(resumed[0]?.sequence, recoveredResult.receipt.resultSequence)
    return {
      protocol: ORCHESTRATION_PROTOCOL_VERSION, committedCommands: 2, committedEvents: 2,
      persistedEffects: 2, replayedCommands: 1, duplicateEffects: 0,
      rolledBackCommands: 1, rolledBackEvents: 0, rolledBackEffects: 0,
      rolledBackPublications: 0, liveEvents: live.length, resumedEvents: resumed.length,
      latestSequence: yield* sink.latestSequence(),
    }
  })
  return Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)))
}
