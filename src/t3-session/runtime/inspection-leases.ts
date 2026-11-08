import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ExecutionInspectionSchema, decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation,
  T3LaneInspectionAcceptedSchema, type T3LaneInspectionAccepted, type T3ExecutionInspection,
  type ExecutorT3Request, type ExecutorT3LaneDelivery, type T3ExecutionReceipt }
  from '@nessie/executor-protocol/t3-session'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'
import { snapshotT3LaneDelivery } from '../../t3-session-delivery.js'
import type { SessionInspectionContext } from './inspection-context.js'
import type { HeldSessionExecutionGraph } from './execution-graph.js'
import type { PreparedSessionLaunchTarget } from './launch-target.js'
import { SessionExecutionGraphRefused } from './execution-graph.js'

type Request = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type Delivery = Parameters<NonNullable<T3SessionLaneRuntime['inspect']>>[2]
type Lease = {
  readonly identity: string
  readonly requestIdentity: string
  readonly challenge: T3ExecutionInspection
  readonly signal: AbortSignal
  readonly stop: AbortController
  readonly demand: Set<Promise<unknown>>
  readonly signingDeadline: number
  readonly retentionExpiresAt: number
  expiresAt: number
  accepted?: T3LaneInspectionAccepted
  accepting?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  scope?: Scope.Closeable
  graph?: HeldSessionExecutionGraph
  receiptDigest?: string
  pending?: Promise<T3ExecutionReceipt>
  closing?: Promise<void>
  cleanupFailed?: boolean
  abort(): void
}
export interface SessionInspectionLeases {
  prepare(request: Request, delivery: Delivery, signal: AbortSignal): Promise<T3ExecutionReceipt>
  accept(request: Request, accepted: T3LaneInspectionAccepted, signal: AbortSignal): Promise<void>
  release(inspectionId: string): Promise<void>
  withRecognized<A>(request: Request, delivery: ExecutorT3LaneDelivery, signal: AbortSignal,
    use: (target: PreparedSessionLaunchTarget, signal: AbortSignal) => Promise<A>): Promise<A>
}

/** Receipt creation is finite, but the original allocated target is held in its
 * own child Scope until the parent resource deadline, explicit release or owner
 * shutdown. The broker supplies the same lifetime signal across ACK. Neither a
 * pipe result nor a receipt's five-second acceptance expiry closes this Scope.
 * This creates no command authority and cannot reconstruct graphs from DTOs. */
export const makeSessionInspectionLeases = (owner: SessionInspectionContext):
  Effect.Effect<SessionInspectionLeases, never, Scope.Scope> => Effect.gen(function* () {
  const parent = yield* Effect.scope
  const leases = new Map<string, Lease>()
  const retired = new Map<string, number>()
  let live = true
  const close = (id: string, lease: Lease): Promise<void> => {
    if (lease.closing) return lease.closing
    clearTimeout(lease.timer)
    lease.signal.removeEventListener('abort', lease.abort)
    lease.stop.abort()
    lease.closing = (async () => {
      // Preparation can still be creating its child Scope. Wait for that handoff
      // before closing it; an unknown failed write is never automatically replayed.
      await lease.pending?.catch(() => undefined)
      await Promise.allSettled([...lease.demand])
      if (lease.scope) await Effect.runPromise(Scope.close(lease.scope, Exit.void))
      if (lease.cleanupFailed) throw new SessionExecutionGraphRefused()
      if (leases.get(id) === lease) {
        retired.set(id, lease.signingDeadline)
        leases.delete(id)
      }
    })()
    void lease.closing.catch(() => undefined)
    return lease.closing
  }
  const arm = (lease: Lease) => {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(lease.abort, Math.max(0, lease.expiresAt - Date.now()))
    lease.timer.unref()
  }
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    live = false
    const results = await Promise.allSettled([...leases].map(([id, lease]) => close(id, lease)))
    const failed = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failed.length) throw new AggregateError(failed, 'T3_INSPECTION_RELEASE_FAILED')
  }))
  const prepare = async (original: Request, offered: Delivery, signal: AbortSignal): Promise<T3ExecutionReceipt> => {
    if (!live || signal.aborted) return Promise.reject(new SessionExecutionGraphRefused())
    const request = decodeExecutorT3LaneOperation(JSON.parse(JSON.stringify(encodeExecutorT3LaneOperation(original))))
    if (request.kind !== 'request' || request.method !== 'orchestration.launchThread') {
      return Promise.reject(new SessionExecutionGraphRefused())
    }
    const delivery = structuredClone(offered)
    const inspection = T3ExecutionInspectionSchema.parse(JSON.parse(delivery.inspection.payload))
    const id = inspection.inspectionId
    const requestIdentity = canonicalExecutorJson(encodeExecutorT3LaneOperation(request))
    const identity = canonicalExecutorJson({ request: encodeExecutorT3LaneOperation(request), delivery })
    const previous = leases.get(id)
    if (previous) {
      if (previous.identity !== identity || previous.closing || previous.signal !== signal || !previous.pending) {
        return Promise.reject(new SessionExecutionGraphRefused())
      }
      return previous.pending.then(receipt => structuredClone(receipt))
    }
    const now = Date.now()
    for (const [key, deadline] of retired) if (deadline <= now) retired.delete(key)
    const retentionExpiresAt = Date.parse(delivery.retentionExpiresAt)
    if (!Number.isSafeInteger(retentionExpiresAt) || retentionExpiresAt <= now
      || retentionExpiresAt < inspection.expiresAtMs || retentionExpiresAt - now > 2_147_483_647
      || inspection.expiresAtMs <= now || inspection.issuedAtMs > now || retired.has(id)
      || leases.size + retired.size >= 64) return Promise.reject(new SessionExecutionGraphRefused())
    const lease: Lease = { identity, requestIdentity, challenge: inspection,
      signal, stop: new AbortController(), demand: new Set(),
      signingDeadline: inspection.expiresAtMs,
      retentionExpiresAt, expiresAt: retentionExpiresAt,
      abort: () => { void close(id, lease).catch(() => undefined) } }
    leases.set(id, lease)
    arm(lease)
    lease.pending = Promise.resolve().then(async () => {
      if (!live || signal.aborted || lease.closing) throw new SessionExecutionGraphRefused()
      const scope = await Effect.runPromise(Scope.fork(parent, 'parallel'))
      lease.scope = scope
      const operation = Effect.uninterruptibleMask(restore => Effect.gen(function* () {
        const child = yield* owner.inspect(request, delivery).pipe(
          Effect.provideService(Scope.Scope, scope), Effect.forkIn(scope))
        return yield* restore(Fiber.join(child)).pipe(Effect.onInterrupt(() => Fiber.interrupt(child).pipe(
          Effect.tap(exit => Effect.sync(() => {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) lease.cleanupFailed = true
          })),
        )))
      }))
      const graph = await Effect.runPromise(operation, { signal: AbortSignal.any([signal, lease.stop.signal]) })
      if (!live || signal.aborted || lease.closing) throw new SessionExecutionGraphRefused()
      lease.graph = graph
      const receipt = graph.receipt
      lease.receiptDigest = 'sha256:' + createHash('sha256').update(canonicalExecutorJson(receipt)).digest('hex')
      return receipt
    })()
    signal.addEventListener('abort', lease.abort, { once: true })
    if (signal.aborted) lease.abort()
    void lease.pending.catch(() => { void close(id, lease).catch(() => undefined) })
    return lease.pending.then(receipt => structuredClone(receipt))
  }
  return {
    prepare,
    accept: async (request, raw, signal) => {
      const accepted = Object.freeze(T3LaneInspectionAcceptedSchema.parse(raw))
      const lease = leases.get(accepted.inspectionId)
      if (!live || !lease?.graph || lease.closing || lease.signal !== signal || signal.aborted
        || lease.expiresAt <= Date.now()
        || lease.requestIdentity !== canonicalExecutorJson(encodeExecutorT3LaneOperation(request))) {
        throw new SessionExecutionGraphRefused()
      }
      if (lease.accepted) {
        if (canonicalExecutorJson(accepted) !== canonicalExecutorJson(lease.accepted)) {
          throw new SessionExecutionGraphRefused()
        }
        await lease.accepting
        if (lease.closing || signal.aborted || lease.expiresAt <= Date.now()) throw new SessionExecutionGraphRefused()
        return
      }
      const challenge = lease.challenge
      const expiresAt = Date.parse(accepted.expiresAt)
      if (accepted.receiptDigest !== lease.receiptDigest || accepted.executorId !== challenge.executorId
        || accepted.environmentId !== challenge.environmentId || accepted.connectionEpoch !== challenge.connectionEpoch
        || accepted.runtimeGeneration !== challenge.runtimeGeneration
        || accepted.sourceRevision !== challenge.sourceRevision || accepted.physicalRootKey !== challenge.sourceRootKey
        || accepted.captureGeneration !== challenge.sourceGeneration
        || accepted.correlationId !== challenge.correlationId || accepted.commandId !== challenge.commandId
        || accepted.requestSha256 !== challenge.requestSha256 || accepted.relayHmac !== challenge.relayHmac
        || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > lease.expiresAt) {
        throw new SessionExecutionGraphRefused()
      }
      lease.accepted = accepted
      lease.expiresAt = expiresAt
      arm(lease)
      const pending = Effect.runPromise(owner.recheck, { signal: AbortSignal.any([signal, lease.stop.signal]) })
      lease.accepting = pending
      lease.demand.add(pending)
      try {
        await pending
        if (!live || lease.closing || signal.aborted || lease.expiresAt <= Date.now()) {
          throw new SessionExecutionGraphRefused()
        }
      } catch (error) {
        // Retire the record without waiting on this same pending demand.
        lease.abort()
        throw error
      } finally { lease.demand.delete(pending) }
    },
    release: async id => { const lease = leases.get(id); if (lease) await close(id, lease) },
    withRecognized: async (original, offered, signal, use) => {
      const request = decodeExecutorT3LaneOperation(JSON.parse(JSON.stringify(encodeExecutorT3LaneOperation(original))))
      if (request.kind !== 'request' || request.method !== 'orchestration.launchThread') {
        throw new SessionExecutionGraphRefused()
      }
      const delivery = snapshotT3LaneDelivery(offered, request)
      if (!live || signal.aborted || !delivery.executionGraph) throw new SessionExecutionGraphRefused()
      const digest = 'sha256:' + createHash('sha256')
        .update(canonicalExecutorJson(delivery.executionGraph)).digest('hex')
      const matches = [...leases.values()].filter(lease => lease.receiptDigest === digest && !lease.closing)
      const lease = matches.length === 1 ? matches[0] : undefined
      if (!lease?.graph || !lease.scope || !lease.accepted
        || lease.signal.aborted || lease.expiresAt <= Date.now()) {
        throw new SessionExecutionGraphRefused()
      }
      await lease.accepting
      if (lease.closing || lease.signal.aborted || lease.expiresAt <= Date.now()) {
        throw new SessionExecutionGraphRefused()
      }
      const graph = lease.graph, scope = lease.scope
      const operation = Effect.uninterruptibleMask(restore => Effect.gen(function* () {
        const child = yield* owner.recognize(graph, request, delivery).pipe(Effect.forkIn(scope))
        return yield* restore(Fiber.join(child)).pipe(Effect.onInterrupt(() => Fiber.interrupt(child)))
      }))
      const demandSignal = AbortSignal.any([signal, lease.signal, lease.stop.signal])
      const pending = (async () => {
        const target = await Effect.runPromise(operation, { signal: demandSignal })
        demandSignal.throwIfAborted()
        return use(target, demandSignal)
      })()
      lease.demand.add(pending)
      try {
        const result = await pending
        if (!live || lease.closing || lease.signal.aborted) throw new SessionExecutionGraphRefused()
        return result
      } finally { lease.demand.delete(pending) }
    },
  }
})
