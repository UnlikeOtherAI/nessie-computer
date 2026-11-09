import { createHash } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { decodeExecutorT3LaneOperation, encodeExecutorT3LaneOperation, isT3NativeLaunchOperation,
  T3ExecutionAdmissionSchema, T3ExecutionFrameAdmissionSchema, T3ExecutionFramePreparationPayloadSchema,
  T3ExecutionGraphPayloadSchema, T3ExecutionReceiptSchema, T3ExecutionSignedAdmissionSchema,
  T3NativeExecutionOperationSchema, T3NativeExecutionReceiptAcceptedSchema,
  T3ExecutionSecretReadPreparationPayloadSchema, T3ExecutionSecretReadAdmissionSchema,
  T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN,
  T3_EXECUTION_FRAME_PREPARATION_DOMAIN,
  T3ExecutionPreclaimPreparationPayloadSchema, T3ExecutionPreclaimAdmissionSchema,
  T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN,
  type ExecutorT3LaneOperation, type ExecutorT3LaneDelivery, type T3ExecutionBinding,
  type T3ExecutionReceipt, type T3ExecutionSignedAdmission, type T3NativeExecutionPhaseInput,
  type T3NativeExecutionFrameInput, type T3NativeExecutionOperation, type T3NativeExecutionReceiptAccepted,
  type T3NativeExecutionSecretReadInput,
  type T3NativeExecutionPreclaimInput,
} from '@nessie/executor-protocol/t3-session'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { snapshotT3LaneDelivery } from './t3-session-delivery.js'
import type { ExecutorLocalState } from './state-store.js'

export interface T3NativeExecutionTransport {
  phase(input: T3NativeExecutionPhaseInput, signal: AbortSignal): Promise<T3ExecutionSignedAdmission>;
  frame(input: T3NativeExecutionFrameInput, signal: AbortSignal): Promise<T3ExecutionSignedAdmission>;
  secretRead(input: T3NativeExecutionSecretReadInput, signal: AbortSignal): Promise<T3ExecutionSignedAdmission>;
  preclaim(input: T3NativeExecutionPreclaimInput, signal: AbortSignal): Promise<T3ExecutionSignedAdmission>;
  receipt(receipt: T3ExecutionReceipt, signal: AbortSignal): Promise<T3NativeExecutionReceiptAccepted>;
}
const refused = () => new Error('T3_NATIVE_TRANSPORT_FENCED')
const sha = (bytes: string) => 'sha256:' + createHash('sha256').update(bytes, 'utf8').digest('hex')
const identity = (state: ExecutorLocalState) => canonicalExecutorJson({ apiBaseUrl: state.apiBaseUrl,
  executorId: state.executorId, connectionEpoch: state.connectionEpoch, machinePublicKey: state.machinePublicKey })

/** Construct in the daemon for one actual offered operation. The protected
 * child receives only finite methods, never state or keys. Parsing/correlation
 * here is transport validation: the native service independently verifies RS256
 * against its protected enrolled origin before any reserve, launch or write.
 */
export function createT3NativeExecutionTransport(state: () => ExecutorLocalState,
  originalRequest: ExecutorT3LaneOperation, originalDelivery: ExecutorT3LaneDelivery, parentSignal: AbortSignal,
  api: Pick<ExecutorApiClient, 'nativeExecution'> = executorApi): T3NativeExecutionTransport {
  const request = decodeExecutorT3LaneOperation(encodeExecutorT3LaneOperation(originalRequest))
  const delivery = snapshotT3LaneDelivery(originalDelivery, request)
  if (!isT3NativeLaunchOperation(request) || request.kind !== 'request' || !request.commandId
    || !delivery.executionGraph) throw refused()
  const graph = T3ExecutionGraphPayloadSchema.parse(JSON.parse(delivery.executionGraph.payload))
  const initial = state(), identityKey = identity(initial), origin = new URL(initial.apiBaseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
    || origin.pathname !== '/' || initial.executorId !== request.executorId
    || initial.connectionEpoch !== request.connectionEpoch) throw refused()
  const requestSha256 = sha(JSON.stringify(encodeExecutorT3LaneOperation(request)))
  const current = () => {
    parentSignal.throwIfAborted()
    const value = state()
    if (identity(value) !== identityKey) throw refused()
    return value
  }
  current()
  const binding = (value: T3ExecutionBinding) => {
    if (value.requestSha256 !== requestSha256 || value.relayHmac !== delivery.requestDigest
      || Object.entries(graph.binding).some(([key, expected]) =>
        value[key as keyof T3ExecutionBinding] !== expected)) throw refused()
  }
  const send = async (raw: T3NativeExecutionOperation, callerSignal: AbortSignal) => {
    const operation = T3NativeExecutionOperationSchema.parse(raw)
    const signal = AbortSignal.any([parentSignal, callerSignal])
    signal.throwIfAborted()
    const before = current()
    const preparedRead = operation.operation === 'execution.secretRead'
      ? T3ExecutionSecretReadPreparationPayloadSchema.parse(JSON.parse(operation.input.preparationReceipt.payload))
      : undefined
    const preparedClaim = operation.operation === 'execution.preclaim'
      ? T3ExecutionPreclaimPreparationPayloadSchema.parse(JSON.parse(operation.input.preparationReceipt.payload))
      : undefined
    let timeoutMs = 5_000
    if (preparedRead && operation.operation === 'execution.secretRead') {
      binding(preparedRead.binding)
      const now = Date.now()
      timeoutMs = Math.min(timeoutMs, preparedRead.expiresAtMs - now, preparedRead.issuedAtMs + 5_000 - now)
      if (operation.input.preparationReceipt.domain !== T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN
        || preparedRead.issuedAtMs > now || timeoutMs <= 0 || preparedRead.acceptedGraphNonce !== graph.nonce
        || canonicalExecutorJson(preparedRead.evidence.custody) !== canonicalExecutorJson(graph.custody)) {
        throw refused()
      }
    }
    if (preparedClaim && operation.operation === 'execution.preclaim') {
      binding(preparedClaim.binding)
      const now = Date.now()
      timeoutMs = Math.min(timeoutMs, preparedClaim.expiresAtMs - now,
        preparedClaim.bound.observation.observedAtMs + 5000 - now)
      if (operation.input.preparationReceipt.domain !== T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN
        || preparedClaim.issuedAtMs > now || timeoutMs <= 0 || preparedClaim.acceptedGraphNonce !== graph.nonce
        || canonicalExecutorJson(preparedClaim.evidence.custody) !== canonicalExecutorJson(graph.custody)) {
        throw refused()
      }
    }
    const payload = { executorId: request.executorId, connectionEpoch: request.connectionEpoch,
      observedAt: new Date().toISOString(), environmentId: request.environmentId,
      correlationId: request.correlationId, relayHmac: delivery.requestDigest, ...operation }
    const result = await api.nativeExecution(before.apiBaseUrl, { ...payload,
      signature: signExecutorDaemonPayload(before.machinePrivateKey, 't3_native_execution', payload),
    }, { signal, timeoutMs })
    signal.throwIfAborted()
    current()
    if (operation.operation === 'execution.receipt') {
      const accepted = T3NativeExecutionReceiptAcceptedSchema.parse(result)
      const observed: unknown = JSON.parse(operation.receipt.payload)
      if (!observed || typeof observed !== 'object' || !('reservationId' in observed)
        || accepted.reservationId !== observed.reservationId || accepted.domain !== operation.receipt.domain
        || Date.parse(accepted.expiresAt) <= Date.now()) throw refused()
      return accepted
    }
    const signed = T3ExecutionSignedAdmissionSchema.parse(result)
    if (operation.operation === 'execution.secretRead' && preparedRead) {
      const read = T3ExecutionSecretReadAdmissionSchema.parse(JSON.parse(signed.payload))
      const { issuerKeyId, preparationReceiptDigest, ...observed } = read
      binding(read.binding)
      if (issuerKeyId !== operation.input.preparationReceipt.keyId
        || preparationReceiptDigest !== sha(operation.input.preparationReceipt.payload)
        || read.issuedAtMs < preparedRead.issuedAtMs || read.issuedAtMs > Date.now()
        || read.expiresAtMs <= Date.now() || read.expiresAtMs > preparedRead.expiresAtMs
        || read.expiresAtMs > preparedRead.issuedAtMs + 5_000
        || canonicalExecutorJson({ ...observed, nonce: preparedRead.nonce,
          issuedAtMs: preparedRead.issuedAtMs, expiresAtMs: preparedRead.expiresAtMs })
          !== canonicalExecutorJson(preparedRead)) throw refused()
    } else if (operation.operation === 'execution.preclaim' && preparedClaim) {
      const claim = T3ExecutionPreclaimAdmissionSchema.parse(JSON.parse(signed.payload))
      const { issuerKeyId, preparationReceiptDigest, ...observed } = claim
      binding(claim.binding)
      if (issuerKeyId !== operation.input.preparationReceipt.keyId
        || preparationReceiptDigest !== sha(operation.input.preparationReceipt.payload)
        || claim.issuedAtMs < preparedClaim.issuedAtMs || claim.issuedAtMs > Date.now()
        || claim.expiresAtMs <= Date.now() || claim.expiresAtMs > preparedClaim.expiresAtMs
        || canonicalExecutorJson({ ...observed, nonce: preparedClaim.nonce,
          issuedAtMs: preparedClaim.issuedAtMs, expiresAtMs: preparedClaim.expiresAtMs })
          !== canonicalExecutorJson(preparedClaim)) throw refused()
    } else if (operation.operation === 'execution.phase') {
      const phase = T3ExecutionAdmissionSchema.parse(JSON.parse(signed.payload))
      binding(phase.binding)
      if (phase.phase !== operation.input.phase || phase.expiresAtMs <= Date.now()
        || 'reservationId' in operation.input && phase.reservationId !== operation.input.reservationId
        || operation.input.phase === 'associate' && (phase.phase !== 'associate'
          || phase.providerSessionId !== operation.input.providerSessionId)) throw refused()
    } else if (operation.operation === 'execution.frame') {
      const frame = T3ExecutionFrameAdmissionSchema.parse(JSON.parse(signed.payload))
      const prepared = T3ExecutionFramePreparationPayloadSchema.parse(JSON.parse(operation.input.frameReceipt.payload))
      binding(frame.binding)
      if (operation.input.frameReceipt.domain !== T3_EXECUTION_FRAME_PREPARATION_DOMAIN
        || frame.reservationId !== operation.input.reservationId || frame.expiresAtMs <= Date.now()
        || frame.frameId !== prepared.frameId || frame.providerSessionId !== prepared.providerSessionId
        || frame.launchDigest !== prepared.launchDigest
        || frame.frameReceiptDigest !== sha(operation.input.frameReceipt.payload)
        || canonicalExecutorJson(frame.frame) !== canonicalExecutorJson(prepared.frame)) throw refused()
    } else throw refused()
    // Preserve exact signed payload bytes. This is not a VerifiedT3EffectGrant.
    return Object.freeze(signed)
  }
  return Object.freeze({
    phase: async (input: T3NativeExecutionPhaseInput, signal: AbortSignal) =>
      Object.freeze(T3ExecutionSignedAdmissionSchema.parse(
        await send({ operation: 'execution.phase', input }, signal))),
    frame: async (input: T3NativeExecutionFrameInput, signal: AbortSignal) =>
      Object.freeze(T3ExecutionSignedAdmissionSchema.parse(
        await send({ operation: 'execution.frame', input }, signal))),
    secretRead: async (input: T3NativeExecutionSecretReadInput, signal: AbortSignal) =>
      Object.freeze(T3ExecutionSignedAdmissionSchema.parse(
        await send({ operation: 'execution.secretRead', input }, signal))),
    preclaim: async (input: T3NativeExecutionPreclaimInput, signal: AbortSignal) =>
      Object.freeze(T3ExecutionSignedAdmissionSchema.parse(
        await send({ operation: 'execution.preclaim', input }, signal))),
    receipt: async (receipt: T3ExecutionReceipt, signal: AbortSignal) => T3NativeExecutionReceiptAcceptedSchema.parse(
      await send({ operation: 'execution.receipt', receipt: T3ExecutionReceiptSchema.parse(receipt) }, signal)),
  })
}
