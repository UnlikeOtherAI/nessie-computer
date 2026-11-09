import { createHash } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { EnvironmentId } from '@nessie/t3-session-source/contracts'
import { T3ExecutionResourceReceiptSchema, T3_EXECUTION_SETTINGS_LIMIT,
  T3ExecutionPendingEffectObservationSchema, type T3ExecutionPendingEffectObservation,
  T3ExecutionProcessLossObservationSchema, type T3ExecutionProcessLossObservation,
  T3ExecutionLegacyShellObservationSchema, type T3ExecutionLegacyShellObservation,
  T3ExecutionRecoveryInputsObservationSchema, type T3ExecutionRecoveryInputsObservation,
  T3ExecutionBoundPendingEffectObservationSchema, type T3ExecutionBoundPendingEffectObservation,
  type T3ExecutionResourceReceipt, type T3ExecutionProviderResource } from '@nessie/executor-protocol'
import { T3ExecutionReceiptSchema, T3ExecutionSignedAdmissionSchema,
  type T3ExecutionGraph, type T3ExecutionReceipt, type T3ExecutionSignedAdmission } from '@nessie/executor-protocol/t3-session'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import { openNativeT3ExecutionResources } from './native.js'
import { heldSourceDatabase } from './database.js'
import type { CaptureDatabase } from '../state/sqlite.js'
import type { ProvenT3Source } from '../import/manifest.js'
import { tablesForLayout } from '../import/layout.js'
import { checkT3SourceLayout } from './layout-check.js'
import { withNativeExecutionDestination, type T3ExecutionDestinationScope } from './execution-destination.js'
import { executionGraphCandidate, withExecutionCommandCapture, type SessionOriginalCommandSink } from './execution-command.js'

export interface T3ExecutionSourceSnapshot {
  readonly source: ProvenT3Source
  /** Fixed catalogue SELECTs only. Producer owns transaction control. */
  readonly database: CaptureDatabase
  readonly sourceHighWater: number
  /** Native resource lifetime only; never a capture or runtime writer UUID. */
  readonly resourceGeneration: string
  recheck(): Promise<void>
}

export interface T3ExecutionResourceScope {
  /** Decode with original ServerSettings in the protected graph callback only.
   * May contain inline credentials; never serialize, log or return these bytes. */
  readonly settingsBytes: Uint8Array
  readonly receipt: T3ExecutionResourceReceipt
  readonly providerReferences: readonly T3ExecutionProviderResource[]
  readonly signal: AbortSignal
  withReadonlySourceSnapshot<A>(use: (snapshot: T3ExecutionSourceSnapshot) => Promise<A>): Promise<A>
  withDestination<A>(use: (destination: T3ExecutionDestinationScope) => Promise<A>): Promise<A>
  /** Actual native row/receipt metadata only; no parent-edge proof or claim grant. */
  inspectPendingEffect(graph: T3ExecutionGraph, effectId: string): Promise<T3ExecutionPendingEffectObservation | null>
  inspectProcessLoss(graph: T3ExecutionGraph): Promise<T3ExecutionProcessLossObservation>
  inspectLegacyShells(graph: T3ExecutionGraph): Promise<T3ExecutionLegacyShellObservation>
  inspectRecoveryInputs(graph: T3ExecutionGraph, threadId: string): Promise<T3ExecutionRecoveryInputsObservation>
  withOriginalCommandLineage<A>(graph: T3ExecutionGraph, retentionExpiresAt: number, signal: AbortSignal,
    use: (sink: SessionOriginalCommandSink) => Promise<A>): Promise<A>
  inspectBoundPendingEffect(graph: T3ExecutionGraph, effectId: string):
    Promise<T3ExecutionBoundPendingEffectObservation | null>
  prepareEffectClaim(graph: T3ExecutionGraph, effectId: string): Promise<T3ExecutionReceipt>
  prepareLegacyShells(graph: T3ExecutionGraph, notAfterMs: number): Promise<T3ExecutionReceipt>
  consumeLegacyShells(graph: T3ExecutionGraph, admission: T3ExecutionSignedAdmission): Promise<{
    slotId: string; planDigest: string; notAfterMs: number; remainingMs: number
  }>
  consumeEffectClaim(graph: T3ExecutionGraph, admission: T3ExecutionSignedAdmission): Promise<{
    claimId: string; effectId: string; rowDigest: string; notAfterMs: number; remainingMs: number
  }>
  recheck(): Promise<void>
}
const scopes = new WeakMap<T3ExecutionResourceScope, () => Promise<void>>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Recognition checks the issued object, never a deserialized receipt or caller
 * callback. The underlying service also rechecks the real graph kernel peer. */
export async function recognizeT3ExecutionResource(scope: T3ExecutionResourceScope):
Promise<T3ExecutionResourceReceipt> {
  const recheck = scopes.get(scope)
  requireCapture(recheck, 't3_execution_resource_not_issued')
  await recheck()
  requireCapture(scopes.get(scope) === recheck && !scope.signal.aborted, 't3_execution_resource_closed')
  return scope.receipt
}

/** Fixed T3SessionGraph entrypoint only. Native resolves existing registration;
 * graph custody, held source and service-issued handles supply proof.
 * This neither consumes nor extends a retained-import grant. */
export async function withT3ExecutionResources<A>(input: {
  readonly stateDirectory: string
  readonly executorId: string
  readonly admittedRootKey: string
  readonly signal?: AbortSignal
}, use: (scope: T3ExecutionResourceScope) => Promise<A>): Promise<A> {
  requireCapture(process.platform === 'win32' && process.arch === 'x64', 't3_execution_resource_platform_unsupported')
  input.signal?.throwIfAborted()
  // stateDirectory is an enrolled startup reference only. The user graph must
  // never open service state or receive its machine keys. Native resolves the
  // actual-token user registration and service verifies its explicit link.
  const native = await openNativeT3ExecutionResources({ executorId: input.executorId,
    admittedRootKey: input.admittedRootKey }, input.signal)
  const abort = new AbortController()
  let live = true
  let bytes: Buffer | undefined
  let scope: T3ExecutionResourceScope | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let snapshotActive = false
  const stop = () => {
    live = false
    abort.abort(new CaptureFailure('t3_execution_resource_closed'))
    if (scope) scopes.delete(scope)
    bytes?.fill(0)
    void native.close()
  }
  const assertLive = () => {
    input.signal?.throwIfAborted()
    requireCapture(live && !abort.signal.aborted, 't3_execution_resource_closed')
  }
  const recheck = async () => {
    try {
      assertLive()
      native.exchange({ op: 'recheck' })
    } catch (error) { stop(); throw error }
  }
  input.signal?.addEventListener('abort', stop, { once: true })
  try {
    await recheck()
    const answer = native.exchange({ op: 'executionDescribe' })
    const parsed = T3ExecutionResourceReceiptSchema.safeParse(answer.receipt)
    requireCapture(parsed.success, 't3_execution_resource_invalid')
    const receipt = freeze(parsed.data)
    requireCapture(receipt.evidence.source.executorId === input.executorId
      && receipt.evidence.source.admittedRootKey === input.admittedRootKey
      && receipt.custody.runtime.pid === process.pid, 't3_execution_resource_mismatch')
    const rawSource = receipt.evidence.source
    const source: ProvenT3Source = Object.freeze({ admittedRootKey: rawSource.admittedRootKey,
      physicalRootKey: rawSource.physicalRootKey,
      environmentId: Schema.decodeUnknownSync(EnvironmentId)(rawSource.environmentId),
      layout: rawSource.layout, databaseRole: rawSource.databaseRole })
    const withReadonlySourceSnapshot = async <A>(
      useSnapshot: (snapshot: T3ExecutionSourceSnapshot) => Promise<A>,
    ): Promise<A> => {
      assertLive()
      requireCapture(!snapshotActive, 't3_execution_source_snapshot_busy')
      snapshotActive = true
      let snapshotId: string | undefined
      let open = false
      const assertSnapshot = () => {
        assertLive()
        requireCapture(open && snapshotActive, 't3_execution_source_snapshot_closed')
      }
      try {
        await recheck()
        const opened = native.exchange({ op: 'executionSnapshotOpen' })
        requireCapture(typeof opened.snapshotId === 'string' && /^[a-f0-9]{64}$/u.test(opened.snapshotId),
          't3_execution_source_snapshot_invalid')
        snapshotId = opened.snapshotId
        open = true
        const reads = heldSourceDatabase(request => {
          assertSnapshot()
          try {
            const result = native.exchange({ op: 'executionSnapshotRead', snapshotId, request })
            assertSnapshot()
            return result
          } catch (error) { stop(); throw error }
        }, source.layout)
        const database: CaptureDatabase = Object.freeze({
          exec() { throw new CaptureFailure('source_write_refused') },
          prepare(sql: string) { assertSnapshot(); return reads.prepare(sql) },
        })
        checkT3SourceLayout(database, source, tablesForLayout(source.layout))
        const sourceHighWater = source.layout === 'v2-80'
          ? database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events').get()?.sequence : 0
        requireCapture(typeof sourceHighWater === 'number' && Number.isSafeInteger(sourceHighWater) && sourceHighWater >= 0,
          'invalid_source_sequence')
        const recheckSnapshot = async () => { assertSnapshot(); await recheck(); assertSnapshot() }
        const snapshot: T3ExecutionSourceSnapshot = Object.freeze({ source, database, sourceHighWater,
          resourceGeneration: receipt.resourceGeneration, recheck: recheckSnapshot })
        await recheckSnapshot()
        const result = await useSnapshot(snapshot)
        await recheckSnapshot()
        native.exchange({ op: 'executionSnapshotClose', snapshotId, action: 'COMMIT' })
        open = false
        await recheck()
        return result
      } catch (error) {
        if (open && live) {
          try { native.exchange({ op: 'executionSnapshotClose', snapshotId, action: 'ROLLBACK' }) }
          catch { stop() }
        }
        stop()
        if (error instanceof CaptureFailure) throw error
        throw new CaptureFailure('t3_execution_source_snapshot_unavailable')
      } finally { open = false; snapshotActive = false }
    }
    const encoded = answer.settingsBase64
    requireCapture(typeof encoded === 'string' && encoded.length <= Math.ceil(T3_EXECUTION_SETTINGS_LIMIT / 3) * 4
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded),
    't3_execution_settings_invalid')
    bytes = Buffer.from(encoded, 'base64')
    requireCapture(bytes.length === receipt.evidence.settingsLength
      && bytes.toString('base64') === encoded
      && createHash('sha256').update(bytes).digest('hex') === receipt.evidence.settingsDigest,
    't3_execution_settings_invalid')
    const heldBytes = bytes
    scope = Object.freeze({
      get settingsBytes() {
        requireCapture(live && !abort.signal.aborted, 't3_execution_resource_closed')
        return heldBytes
      },
      receipt, providerReferences: receipt.evidence.providerReferences, signal: abort.signal,
      recheck, withReadonlySourceSnapshot,
      withDestination: async <R>(useDestination: (destination: T3ExecutionDestinationScope) => Promise<R>) => {
        await recheck()
        const result = await withNativeExecutionDestination(native.exchange, receipt, abort.signal, useDestination)
        await recheck()
        return result
      },
      inspectPendingEffect: async (graph: T3ExecutionGraph, effectId: string) => {
        await recheck()
        const candidate = executionGraphCandidate(graph, receipt)
        const answer = native.exchange({ op: 'executionDestinationObserveEffect', graph: candidate, effectId })
        const observed = T3ExecutionPendingEffectObservationSchema.nullable().parse(answer.observation)
        requireCapture(observed === null || observed.effectId === effectId
          && observed.threadId === candidate.binding.threadId, 'execution_destination_effect_mismatch')
        await recheck()
        return observed
      },
      inspectProcessLoss: async (graph: T3ExecutionGraph) => {
        await recheck()
        const candidate = executionGraphCandidate(graph, receipt)
        const answer = native.exchange({ op: 'executionDestinationObserveProcessLoss', graph: candidate })
        const observation = T3ExecutionProcessLossObservationSchema.parse(answer.observation)
        await recheck()
        return observation
      },
      inspectLegacyShells: async (graph: T3ExecutionGraph) => {
        await recheck()
        const candidate = executionGraphCandidate(graph, receipt)
        const answer = native.exchange({ op: 'executionDestinationObserveLegacyShells', graph: candidate })
        const observation = T3ExecutionLegacyShellObservationSchema.parse(answer.observation)
        await recheck()
        return observation
      },
      inspectRecoveryInputs: async (graph: T3ExecutionGraph, threadId: string) => {
        await recheck()
        const candidate = executionGraphCandidate(graph, receipt)
        const target = T3ExecutionRecoveryInputsObservationSchema.shape.threadId.parse(threadId)
        const answer = native.exchange({ op: 'executionDestinationObserveRecoveryInputs', graph: candidate,
          threadId: target })
        const observation = T3ExecutionRecoveryInputsObservationSchema.parse(answer.observation)
        requireCapture(observation.threadId === target, 't3_execution_recovery_input_mismatch')
        await recheck()
        return observation
      },
      withOriginalCommandLineage: <R>(graph: T3ExecutionGraph, retentionExpiresAt: number, parent: AbortSignal,
        useSink: (sink: SessionOriginalCommandSink) => Promise<R>) => withExecutionCommandCapture(native.exchange,
        receipt, recheck, stop, graph, retentionExpiresAt, AbortSignal.any([abort.signal, parent]), useSink),
      inspectBoundPendingEffect: async (graph: T3ExecutionGraph, effectId: string) => {
        await recheck()
        const candidate = executionGraphCandidate(graph, receipt)
        const answer = native.exchange({ op: 'executionDestinationObserveBoundEffect', graph: candidate, effectId })
        const bound = T3ExecutionBoundPendingEffectObservationSchema.nullable().parse(answer.bound)
        requireCapture(bound === null || bound.observation.effectId === effectId
          && bound.observation.threadId === candidate.binding.threadId
          && bound.original.parentCommandId === candidate.binding.commandId
          && bound.original.threadId === candidate.binding.threadId
          && bound.original.providerInstanceId === candidate.binding.providerInstanceId,
        'execution_destination_effect_mismatch')
        await recheck()
        return bound
      },
      prepareEffectClaim: async (graph: T3ExecutionGraph, effectId: string) => {
        const candidate = executionGraphCandidate(graph, receipt)
        await recheck()
        const answer = native.exchange({ op: 'executionEffectClaimPrepare', graph: candidate, effectId })
        const proof = T3ExecutionReceiptSchema.parse(answer.receipt)
        await recheck()
        return proof
      },
      prepareLegacyShells: async (graph: T3ExecutionGraph, notAfterMs: number) => {
        const candidate = executionGraphCandidate(graph, receipt)
        requireCapture(Number.isSafeInteger(notAfterMs) && notAfterMs > 0, 'execution_legacy_shell_window_invalid')
        await recheck()
        const answer = native.exchange({ op: 'executionLegacyShellPrepare', graph: candidate, notAfterMs })
        const proof = T3ExecutionReceiptSchema.parse(answer.receipt)
        await recheck()
        return proof
      },
      consumeLegacyShells: async (graph: T3ExecutionGraph, admission: T3ExecutionSignedAdmission) => {
        const candidate = executionGraphCandidate(graph, receipt)
        const signed = T3ExecutionSignedAdmissionSchema.parse(admission)
        await recheck()
        const answer = native.exchange({ op: 'executionLegacyShellConsume', graph: candidate, admission: signed })
        requireCapture(Object.keys(answer).sort().join(',') === 'notAfterMs,planDigest,remainingMs,slotId'
          && typeof answer.slotId === 'string' && /^[a-f0-9]{64}$/u.test(answer.slotId)
          && typeof answer.planDigest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(answer.planDigest)
          && typeof answer.notAfterMs === 'number' && Number.isSafeInteger(answer.notAfterMs)
          && typeof answer.remainingMs === 'number' && Number.isSafeInteger(answer.remainingMs)
          && answer.remainingMs > 0 && answer.remainingMs <= 5000, 'execution_legacy_shell_unavailable')
        await recheck()
        return { slotId: answer.slotId, planDigest: answer.planDigest,
          notAfterMs: answer.notAfterMs, remainingMs: answer.remainingMs }
      },
      consumeEffectClaim: async (graph: T3ExecutionGraph, admission: T3ExecutionSignedAdmission) => {
        const candidate = executionGraphCandidate(graph, receipt)
        const signed = T3ExecutionSignedAdmissionSchema.parse(admission)
        await recheck()
        const answer = native.exchange({ op: 'executionEffectClaimConsume', graph: candidate, admission: signed })
        requireCapture(Object.keys(answer).sort().join(',') === 'claimId,effectId,notAfterMs,remainingMs,rowDigest'
          && typeof answer.claimId === 'string' && /^[a-f0-9]{64}$/u.test(answer.claimId)
          && typeof answer.effectId === 'string' && typeof answer.rowDigest === 'string'
          && /^sha256:[a-f0-9]{64}$/u.test(answer.rowDigest)
          && typeof answer.notAfterMs === 'number' && Number.isSafeInteger(answer.notAfterMs)
          && typeof answer.remainingMs === 'number' && Number.isSafeInteger(answer.remainingMs)
          && answer.remainingMs > 0 && answer.remainingMs <= 5000, 'execution_effect_claim_unavailable')
        await recheck()
        return { claimId: answer.claimId, effectId: answer.effectId, rowDigest: answer.rowDigest,
          notAfterMs: answer.notAfterMs, remainingMs: answer.remainingMs }
      },
    })
    scopes.set(scope, recheck)
    // Renewal checks actual service/native resources. It does not renew any
    // human consent, inspection challenge or finite command admission.
    timer = setInterval(() => { void recheck().catch(() => { /* stop already invalidated the scope */ }) }, 20_000)
    timer.unref()
    await recheck()
    const result = await use(scope)
    requireCapture(!snapshotActive, 't3_execution_source_snapshot_still_open')
    await recheck()
    native.exchange({ op: 'close' })
    return result
  } finally {
    if (timer) clearInterval(timer)
    input.signal?.removeEventListener('abort', stop)
    stop()
    await native.close()
  }
}
