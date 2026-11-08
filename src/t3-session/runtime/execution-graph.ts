import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { encodeExecutorT3LaneOperation, requestTargets, T3ExecutionInspectionSchema,
  T3ExecutionSignedAdmissionSchema, T3ExecutionGraphPayloadSchema, T3_EXECUTION_GRAPH_DOMAIN,
  type ExecutorT3Request, type ExecutorT3LaneDelivery, type T3ExecutionSignedAdmission,
  type T3ExecutionReceipt } from '@nessie/executor-protocol/t3-session'
import { createT3ExecutionNativeClient } from '../../t3-execution-native-client.js'
import type { T3ExecutionResourceScope } from '../source/execution.js'
import { prepareSessionLaunchTarget, recheckSessionLaunchTarget,
  type PreparedSessionLaunchTarget, type SessionLaunchTargetPreparation, type SessionLaunchTargetCheck }
  from './launch-target.js'
import { readSessionExecutionResources, type SessionExecutionResourcesEffect } from './execution-resources.js'
import type { EffectFailure, EffectServices } from './effect-types.js'

type LaunchRequest = Extract<ExecutorT3Request, { readonly method: 'orchestration.launchThread' }>
type InspectionDelivery = { readonly inspection: T3ExecutionSignedAdmission; readonly relayHmac: string }
export type SessionExecutionGraphPreparation = Effect.Effect<HeldSessionExecutionGraph,
  SessionExecutionGraphRefused | EffectFailure<SessionLaunchTargetPreparation | SessionExecutionResourcesEffect>,
  EffectServices<SessionLaunchTargetPreparation | SessionExecutionResourcesEffect> | Scope.Scope>
export type SessionExecutionGraphRecognition = Effect.Effect<PreparedSessionLaunchTarget,
  SessionExecutionGraphRefused | EffectFailure<SessionLaunchTargetCheck | SessionExecutionResourcesEffect>,
  EffectServices<SessionLaunchTargetCheck | SessionExecutionResourcesEffect>>
type Record = { selection: PreparedSessionLaunchTarget; source: T3ExecutionResourceScope;
  receipt: T3ExecutionReceipt; relayHmac: string; resourceGeneration: string }
const records = new WeakMap<HeldSessionExecutionGraph, Record>()
const token = Object.freeze({})

export class SessionExecutionGraphRefused extends Error {
  constructor() { super('T3_SESSION_EXECUTION_GRAPH_REFUSED'); this.name = 'SessionExecutionGraphRefused' }
}

/** Issued only after the real native service signs this held original selection.
 * The receipt is evidence for backend inspection intake, never a launch grant.
 * Its record dies with the same enclosing source/selection scope.
 */
export class HeldSessionExecutionGraph {
  private constructor(key: object, record: Record) {
    if (key !== token) throw new SessionExecutionGraphRefused()
    records.set(this, record)
    Object.freeze(this)
  }
  get receipt(): T3ExecutionReceipt {
    const record = records.get(this)
    if (!record) throw new SessionExecutionGraphRefused()
    return structuredClone(record.receipt)
  }

  static readonly prepare = (request: LaunchRequest, delivery: InspectionDelivery,
    source: T3ExecutionResourceScope): SessionExecutionGraphPreparation => Effect.gen(function* () {
    const signed = T3ExecutionSignedAdmissionSchema.parse(delivery.inspection)
    // Parsing rejects substitutions before native work; ONLY the native service
    // verifies the backend signature/current enrollment before signing a graph.
    const inspection = T3ExecutionInspectionSchema.parse(JSON.parse(signed.payload))
    const digest = 'sha256:' + createHash('sha256')
      .update(JSON.stringify(encodeExecutorT3LaneOperation(request)), 'utf8').digest('hex')
    const targets = requestTargets(request)
    if (inspection.requestSha256 !== digest || inspection.relayHmac !== delivery.relayHmac
      || inspection.executorId !== request.executorId || inspection.environmentId !== request.environmentId
      || inspection.connectionEpoch !== request.connectionEpoch
      || inspection.runtimeGeneration !== request.runtimeGeneration
      || inspection.correlationId !== request.correlationId || inspection.commandId !== request.commandId
      || inspection.commandId !== request.input.commandId || inspection.sourceRevision !== request.sourceRevision
      || canonicalExecutorJson(inspection.targets) !== canonicalExecutorJson(targets)) {
      return yield* Effect.fail(new SessionExecutionGraphRefused())
    }
    const assertDeadline = Effect.try({ try: () => {
      source.signal.throwIfAborted()
      if (inspection.issuedAtMs > Date.now() || inspection.expiresAtMs <= Date.now()) {
        throw new SessionExecutionGraphRefused()
      }
    }, catch: () => new SessionExecutionGraphRefused() })
    yield* assertDeadline
    const deadline = AbortSignal.timeout(Math.max(0, inspection.expiresAtMs - Date.now()))
    const selection = yield* prepareSessionLaunchTarget(request)
    const bound = yield* readSessionExecutionResources(source, selection)
    if (inspection.sourceRootKey !== bound.receipt.evidence.source.physicalRootKey) {
      return yield* Effect.fail(new SessionExecutionGraphRefused())
    }
    const native = yield* Effect.tryPromise({ try: signal => createT3ExecutionNativeClient(request.executorId,
      AbortSignal.any([source.signal, deadline, signal])), catch: () => new SessionExecutionGraphRefused() })
    yield* assertDeadline
    if (native.descriptor.keyId !== inspection.issuerKeyId
      || canonicalExecutorJson(native.descriptor.custody) !== canonicalExecutorJson(bound.receipt.custody)) {
      return yield* Effect.fail(new SessionExecutionGraphRefused())
    }
    const { executorId, environmentId, connectionEpoch, runtimeGeneration, correlationId, commandId,
      requestSha256, relayHmac, actorReference, initiationReference, sourceRootKey, sourceGeneration } = inspection
    const graph = {
      version: 1 as const, nonce: inspection.nonce, sourceRevision: inspection.sourceRevision,
      binding: { executorId, environmentId, connectionEpoch, runtimeGeneration, correlationId, commandId,
        requestSha256, relayHmac, actorReference, initiationReference, sourceRootKey, sourceGeneration,
        threadId: selection.threadId, providerInstanceId: selection.providerInstanceId, driver: selection.driver,
        continuationHomeKey: bound.continuationHomeKey, historyHomeKey: bound.historyHomeKey,
        credentialBindingId: bound.credentialBindingId },
      targets: [...targets], issuedAtMs: inspection.issuedAtMs, expiresAtMs: inspection.expiresAtMs,
    }
    yield* readSessionExecutionResources(source, selection)
    yield* assertDeadline
    const receipt = yield* Effect.tryPromise({ try: signal => native.graph(signed, bound.receipt.resourceId, graph,
      AbortSignal.any([source.signal, deadline, signal])), catch: () => new SessionExecutionGraphRefused() })
    yield* assertDeadline
    yield* readSessionExecutionResources(source, selection)
    const observed = T3ExecutionGraphPayloadSchema.parse(JSON.parse(receipt.payload))
    if (receipt.domain !== T3_EXECUTION_GRAPH_DOMAIN
      || canonicalExecutorJson(observed) !== canonicalExecutorJson({ ...graph, custody: bound.receipt.custody })) {
      return yield* Effect.fail(new SessionExecutionGraphRefused())
    }
    const held = new HeldSessionExecutionGraph(token, { selection, source, receipt,
      relayHmac: delivery.relayHmac, resourceGeneration: bound.receipt.resourceGeneration })
    yield* Effect.addFinalizer(() => Effect.sync(() => { records.delete(held) }))
    return held
  })
}

/** Exact same held graph on normal admitted delivery. Receipt expiry limits
 * first backend intake; it is NOT renewed here or used as execution authority.
 * The caller must still consume the actual reserve/command/launch admissions.
 */
export const recognizeSessionExecutionGraph = (held: HeldSessionExecutionGraph, request: LaunchRequest,
  delivery: ExecutorT3LaneDelivery): SessionExecutionGraphRecognition => Effect.gen(function* () {
  const record = records.get(held)
  if (!record || !delivery.executionGraph || !delivery.provenance
    || delivery.requestDigest !== record.relayHmac
    || canonicalExecutorJson(delivery.executionGraph) !== canonicalExecutorJson(record.receipt)) {
    return yield* Effect.fail(new SessionExecutionGraphRefused())
  }
  yield* recheckSessionLaunchTarget(record.selection, request)
  const bound = yield* readSessionExecutionResources(record.source, record.selection)
  if (bound.receipt.resourceGeneration !== record.resourceGeneration) {
    return yield* Effect.fail(new SessionExecutionGraphRefused())
  }
  return record.selection
})

export const prepareSessionExecutionGraph: typeof HeldSessionExecutionGraph.prepare = HeldSessionExecutionGraph.prepare
