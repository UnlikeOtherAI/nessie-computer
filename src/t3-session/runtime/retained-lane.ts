import { randomUUID } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ExecutorT3LaneOperation, T3_SOURCE_COMMIT, T3_LANE_LIMITS, isRetainedT3LaneOperation,
  type ExecutorT3LaneReply, type ExecutorT3LaneDelivery, type T3RuntimeAnnouncement,
} from '@nessie/executor-protocol/t3-session'
import { loadExecutorState } from '../../state-store.js'
import { snapshotT3LaneDelivery } from '../../t3-session-delivery.js'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'
import type { HeldRetainedCatalogGraph } from '../catalog/held-graph.js'
import { retainedImportOperationBinding } from '../ownership/import-operation.js'
import { requireCapture } from '../state/sqlite.js'
import type { HeldRetainedRuntimeSource } from './retained-source.js'
import type { RetainedCaptureWorkspace } from './capture-workspace.js'
import { sessionDispatchScope } from './dispatch-scope.js'
import { dispatchRetainedHttp, dispatchSessionRpc } from './dispatch.js'
import { bindRetainedCatalogHttp, bindRetainedCatalogSlots } from './slots.js'
import { runSessionEffect } from './operation-scope.js'

/** A finite source iterator must finish before its scoped slots can close. */
async function finiteReply(source: AsyncIterable<ExecutorT3LaneReply>): Promise<ExecutorT3LaneReply> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    requireCapture(!first.done, 'retained_runtime_empty_reply')
    requireCapture((await iterator.next()).done, 'retained_runtime_nonfinite_reply')
    return first.value
  } finally { await iterator.return?.() }
}

/**
 * Internal composition called only inside the actual captured graph callback.
 * No source/database is opened here. The sole daemon lane receives this port;
 * graph readiness is finite retained reading, never stream or native readiness.
 */
export async function withHeldRetainedLane<A>(stateDirectory: string, held: HeldRetainedRuntimeSource,
  storage: RetainedCaptureWorkspace, graph: HeldRetainedCatalogGraph,
  use: (lane: T3SessionLaneRuntime, signal: AbortSignal) => Promise<A>): Promise<A> {
  const lifetime = new AbortController()
  const signal = AbortSignal.any([held.signal, storage.signal, graph.signal, lifetime.signal])
  const pending = new Set<Promise<unknown>>()
  const deadlines = new Set<ReturnType<typeof setTimeout>>()
  let active = true
  let failed = false
  let failure: unknown
  const assertOpen = () => {
    signal.throwIfAborted()
    requireCapture(active, 'retained_runtime_closed')
    storage.assertCurrent()
  }
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const joined = operation.finally(() => { pending.delete(joined) })
    pending.add(joined)
    void joined.catch(() => undefined)
    return joined
  }
  try {
    assertOpen()
    requireCapture(graph.source === held.local.source && graph.captureGeneration === held.local.captureGeneration
      && graph.readiness === 'retained-read-only', 'retained_runtime_graph_substitution')
    const initial = await held.checked(() => loadExecutorState(stateDirectory))
    requireCapture(initial.executorId === held.local.challenge.executorId && initial.connectionEpoch,
      'retained_runtime_enrollment_mismatch')
    // Retain only the enrolled routing identity, not a second credential store.
    const identity = { executorId: initial.executorId, epoch: initial.connectionEpoch,
      apiBaseUrl: initial.apiBaseUrl, machinePublicKey: initial.machinePublicKey }
    const recheck = async () => {
      try {
        assertOpen()
        await graph.recheck()
        assertOpen()
        const current = await held.checked(() => loadExecutorState(stateDirectory))
        requireCapture(current.executorId === identity.executorId && current.connectionEpoch === identity.epoch
          && current.apiBaseUrl === identity.apiBaseUrl && current.machinePublicKey === identity.machinePublicKey,
        'retained_runtime_enrollment_changed')
        assertOpen()
      } catch (error) {
        if (active && !failed) { failed = true; failure = error }
        lifetime.abort(error)
        throw error
      }
    }
    await recheck()
    // Mint after the actual writer, capture and read graph are all held. This
    // incarnation identifies only this callback, not the original environment.
    const runtimeGeneration = randomUUID()
    const announcement = Object.freeze({ environmentId: graph.source.environmentId, runtimeGeneration,
      sourceRevision: T3_SOURCE_COMMIT, physicalRootKey: graph.source.physicalRootKey,
      captureGeneration: graph.captureGeneration, state: 'ready' as const })

    const program = Effect.gen(function* () {
      const bindDemand = yield* sessionDispatchScope
      const lane: T3SessionLaneRuntime = Object.freeze({
        describe: () => track((async (): Promise<readonly T3RuntimeAnnouncement[]> => {
          if (!active || signal.aborted) return []
          try { await recheck(); return [announcement] } catch { return [] }
        })()),
        open: (request: ExecutorT3LaneOperation, caller: AbortSignal, raw: ExecutorT3LaneDelivery) => {
          assertOpen()
          caller.throwIfAborted()
          requireCapture(Schema.is(ExecutorT3LaneOperation)(request), 'retained_runtime_request_invalid')
          requireCapture(isRetainedT3LaneOperation(request), 'retained_runtime_operation_unbound')
          // Snapshot the carrier again at the graph boundary. Keep the original
          // decoded input object; it is the one used for binding and dispatch.
          const delivery = snapshotT3LaneDelivery(raw, request)
          requireCapture(delivery.catalogLeases?.length === 1, 'retained_runtime_single_grant_required')
          const lease = delivery.catalogLeases[0]!
          const binding = retainedImportOperationBinding(lease, request, delivery.requestDigest)
          const checkRequest = () => {
            assertOpen()
            requireCapture(request.executorId === identity.executorId && request.connectionEpoch === identity.epoch
              && request.runtimeGeneration === runtimeGeneration && request.environmentId === graph.source.environmentId
              && request.sourceRevision === T3_SOURCE_COMMIT, 'retained_runtime_routing_mismatch')
            requireCapture(lease.physicalRootKey === graph.source.physicalRootKey
              && lease.captureGeneration === graph.captureGeneration, 'retained_runtime_capture_mismatch')
            requireCapture(Date.now() < Date.parse(lease.expiresAt), 'retained_runtime_lease_expired')
            retainedImportOperationBinding(lease, request, delivery.requestDigest)
          }
          checkRequest()
          // This is the actual local consent/native/server authority. Descriptor
          // decoding, a ready announcement and provenance cannot replace it.
          const authority = held.local.authority(lease, binding)
          requireCapture(deadlines.size < T3_LANE_LIMITS.active, 'retained_runtime_capacity')
          const deadline = new AbortController()
          const timer = setTimeout(() => {
            deadlines.delete(timer)
            deadline.abort(new Error('retained_runtime_lease_expired'))
          }, Math.max(0, Date.parse(lease.expiresAt) - Date.now()))
          deadlines.add(timer)
          timer.unref()
          return bindDemand(async function* (demandSignal) {
            const operationSignal = AbortSignal.any([signal, demandSignal, deadline.signal])
            try {
              operationSignal.throwIfAborted()
              checkRequest()
              await recheck()
              operationSignal.throwIfAborted()
              checkRequest()
              const service = graph.createReadService(authority)
              const read = Effect.gen(function* () {
                const source = request.kind === 'request'
                  ? dispatchSessionRpc(request, yield* bindRetainedCatalogSlots(service), operationSignal)
                  : dispatchRetainedHttp(request, yield* bindRetainedCatalogHttp(service), operationSignal)
                // Cancellation reaches the actual iterator through its signal;
                // join its return before releasing the per-operation slots.
                return yield* Effect.promise(() => finiteReply(source)).pipe(Effect.uninterruptible)
              })
              const result = await runSessionEffect(Effect.scoped(read), operationSignal)
              await recheck()
              operationSignal.throwIfAborted()
              checkRequest()
              yield result
            } finally { clearTimeout(timer); deadlines.delete(timer) }
          }, AbortSignal.any([signal, caller, deadline.signal]))
        },
      })
      // Callback observes signal and drains the single daemon lane. Its pending
      // demand closes before the surrounding held read graph and SQLite release.
      return yield* Effect.promise(() => use(lane, signal)).pipe(Effect.uninterruptible,
        Effect.ensuring(Effect.promise(async () => {
          active = false
          lifetime.abort(new Error('retained_runtime_closed'))
          for (const timer of deadlines) clearTimeout(timer)
          deadlines.clear()
          while (pending.size) await Promise.allSettled([...pending])
        })))
    })
    const result = await Effect.runPromise(Effect.scoped(program))
    if (failed) throw failure
    held.signal.throwIfAborted()
    storage.signal.throwIfAborted()
    graph.signal.throwIfAborted()
    return result
  } finally { active = false; lifetime.abort(new Error('retained_runtime_closed')) }
}
