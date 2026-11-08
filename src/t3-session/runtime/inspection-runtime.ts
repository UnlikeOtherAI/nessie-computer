import * as Effect from 'effect/Effect'
import { T3_SOURCE_COMMIT, T3InspectionRuntimeAnnouncementSchema,
  type ExecutorT3LaneOperation, type ExecutorT3Request } from '@nessie/executor-protocol/t3-session'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../source/execution.js'
import type { HeldSessionExecutionState } from './execution-state.js'
import { makeSessionInspectionContext, type SessionInspectionContext } from './inspection-context.js'
import { makeSessionInspectionLeases, type SessionInspectionLeases } from './inspection-leases.js'
import { SessionExecutionGraphRefused } from './execution-graph.js'

export type SessionInspectionRuntime = Required<Pick<T3SessionLaneRuntime,
  'describeInspections' | 'inspect' | 'acceptInspection' | 'releaseInspection'>>

export interface HeldSessionInspectionRuntime {
  readonly runtime: SessionInspectionRuntime
  /** The same original memo/scope owner, for later separately admitted activation. */
  readonly original: SessionInspectionContext
  readonly withRecognized: SessionInspectionLeases['withRecognized']
  readonly signal: AbortSignal
}

function launch(request: ExecutorT3LaneOperation):
  Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }> {
  if (request.kind !== 'request' || request.method !== 'orchestration.launchThread') {
    throw new SessionExecutionGraphRefused()
  }
  return request
}

/** Called inside the actual execution-resource and destination-writer callbacks.
 * No source/SQL reopen, provider hydration or second engine. The callback must
 * observe signal; all inspections and dispatch callbacks drain before return.
 * This port has no retained describe/open and grants no command authority. */
export async function withHeldSessionInspectionRuntime<A>(source: T3ExecutionResourceScope,
  state: HeldSessionExecutionState, use: (held: HeldSessionInspectionRuntime) => Promise<A>,
  caller: AbortSignal): Promise<A> {
  const stop = new AbortController()
  const signal = AbortSignal.any([source.signal, state.signal, caller, stop.signal])
  const pending = new Set<Promise<unknown>>()
  const parentSignals = new WeakMap<AbortSignal, AbortSignal>()
  let live = true
  const current = async () => {
    try {
      signal.throwIfAborted()
      if (!live) throw new SessionExecutionGraphRefused()
      const receipt = await recognizeT3ExecutionResource(source)
      await state.recheck()
      signal.throwIfAborted()
      if (!live || receipt.evidence.source.physicalRootKey !== state.source.physicalRootKey
        || receipt.evidence.source.environmentId !== state.source.environmentId
        || receipt.evidence.source.admittedRootKey !== state.source.admittedRootKey) {
        throw new SessionExecutionGraphRefused()
      }
    } catch { stop.abort(); throw new SessionExecutionGraphRefused() }
  }
  const demandSignal = (parent: AbortSignal): AbortSignal => {
    let held = parentSignals.get(parent)
    if (!held) { held = AbortSignal.any([signal, parent]); parentSignals.set(parent, held) }
    return held
  }
  const track = <T>(start: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(start)
    pending.add(work)
    void work.finally(() => pending.delete(work)).catch(() => undefined)
    return work
  }
  await current()
  const program = Effect.gen(function* () {
    const original = yield* makeSessionInspectionContext(source, state)
    const leases = yield* makeSessionInspectionLeases(original)
    const runtime = Object.freeze<SessionInspectionRuntime>({
      describeInspections: () => track(async () => {
        await current()
        return [T3InspectionRuntimeAnnouncementSchema.parse({ role: 'source-inspection',
          environmentId: state.source.environmentId, runtimeGeneration: state.owner.runtimeGeneration,
          sourceRevision: T3_SOURCE_COMMIT, physicalRootKey: state.source.physicalRootKey,
          captureGeneration: state.captureGeneration })]
      }),
      inspect: (request, parent, delivery) => track(async () => {
        await current()
        const result = await leases.prepare(launch(request), delivery, demandSignal(parent))
        await current()
        return result
      }),
      acceptInspection: (request, accepted, parent) => track(async () => {
        await current()
        await leases.accept(launch(request), accepted, demandSignal(parent))
        await current()
      }),
      releaseInspection: id => track(() => leases.release(id)),
    })
    const withRecognized: SessionInspectionLeases['withRecognized'] = (request, delivery, parent, dispatch) =>
      track(async () => {
        await current()
        const result = await leases.withRecognized(request, delivery, demandSignal(parent), dispatch)
        await current()
        return result
      })
    return yield* Effect.promise(() => use(Object.freeze({ runtime, original, withRecognized, signal }))).pipe(
      Effect.uninterruptible,
      Effect.ensuring(Effect.promise(async () => {
        live = false
        stop.abort()
        while (pending.size) await Promise.allSettled([...pending])
      })),
    )
  })
  try { return await Effect.runPromise(Effect.scoped(program)) }
  finally { live = false; stop.abort() }
}
