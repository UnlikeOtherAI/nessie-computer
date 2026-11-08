import { createHash, randomUUID } from 'node:crypto'
import { canonicalExecutorJson, executorCodingSessionResultScope, ExecutorSessionAuthorityCheckedSchema,
  type ExecutorSessionAuthorityCheck,
  type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** A fresh round trip for one exact operation. The response cannot replace its original selection. */
export const createSessionAuthorityClient = (
  state: () => ExecutorLocalState, api: Pick<ExecutorApiClient, 'checkSessionAuthority'> = executorApi,
) => async (scope: ExecutorCodingSessionAuthority, phase: 'execute' | 'publish'): Promise<ExecutorCodingSessionAuthority> => {
  const before = state()
  if (before.sessionPairingSource?.kind !== 'bound' || before.executorId !== scope.executorId
    || before.connectionEpoch !== scope.connectionEpoch
    || before.sessionPairingSource.originalOwnerGeneration !== scope.originalOwnerGeneration) {
    throw new Error('Original session source is unavailable')
  }
  const selectionDigest = `sha256:${createHash('sha256')
    .update(canonicalExecutorJson(executorCodingSessionResultScope(scope))).digest('hex')}`
  const kind = scope.operation === 'session_view' ? 'view'
    : scope.operation === 'session_user_action' ? 'action' : 'command'
  const payload: Omit<ExecutorSessionAuthorityCheck, 'signature'> = {
    executorId: before.executorId, connectionEpoch: before.connectionEpoch,
    commandId: scope.commandId, selectionDigest, kind, phase,
    observedAt: new Date().toISOString(), requestNonce: randomUUID() }
  const startedAt = Date.now()
  const answer = ExecutorSessionAuthorityCheckedSchema.parse(await api.checkSessionAuthority(before.apiBaseUrl, {
    ...payload, signature: signExecutorDaemonPayload(before.machinePrivateKey, 'session_authority', payload),
  }))
  const current = state()
  const requestDigest = `sha256:${createHash('sha256').update(canonicalExecutorJson(payload)).digest('hex')}`
  if (current.executorId !== before.executorId || current.connectionEpoch !== before.connectionEpoch
    || answer.commandId !== scope.commandId || answer.selectionDigest !== selectionDigest || answer.phase !== phase
    || answer.requestNonce !== payload.requestNonce || answer.requestDigest !== requestDigest
    || current.apiBaseUrl !== before.apiBaseUrl || current.machinePublicKey !== before.machinePublicKey
    || current.sessionPairingSource?.kind !== 'bound'
    || current.sessionPairingSource.originalOwnerGeneration !== scope.originalOwnerGeneration
    || answer.connectionEpoch !== current.connectionEpoch
    || answer.authorizationRevision !== scope.authorizationRevision
    || answer.purpose !== scope.purpose || Date.parse(answer.validUntil) <= Date.now()
    || Date.now() - startedAt >= 5_000 || Date.parse(answer.validUntil) > Date.now() + 5_000
    || canonicalExecutorJson(executorCodingSessionResultScope(answer.authority))
      !== canonicalExecutorJson(executorCodingSessionResultScope(scope))) throw new Error('Original session authority changed')
  return { ...answer.authority, expiresAt: new Date(Math.min(Date.parse(answer.authority.expiresAt),
    Date.parse(answer.validUntil), startedAt + 5_000)).toISOString() }
}
