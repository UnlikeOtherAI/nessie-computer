import { createHash, randomUUID } from 'node:crypto'
import { canonicalExecutorJson, executorCodingSessionResultScope, ExecutorSessionAuthorityCheckedSchema,
  type ExecutorSessionAuthorityCheck,
  type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/** The route's selection carrier and this consumption's short effect permit have different lifetimes. */
export type CheckedSessionAuthority = {
  carrier: ExecutorCodingSessionAuthority
  permit: ExecutorCodingSessionAuthority
}

/**
 * How far this computer's clock may run behind the server's. The route stamps its deadline five seconds from its
 * own clock, so with no allowance a computer a few milliseconds slow refused every answer. The allowance never
 * lengthens a permit: it is still cut at five seconds of this computer's own time, from before the request left.
 */
const CLOCK_ALLOWANCE_MS = 2_000

/** A fresh round trip for one exact operation. The response cannot replace its original selection. */
export const createSessionAuthorityClient = (
  state: () => ExecutorLocalState, api: Pick<ExecutorApiClient, 'checkSessionAuthority'> = executorApi,
) => async (scope: ExecutorCodingSessionAuthority, phase: 'execute' | 'publish'): Promise<CheckedSessionAuthority> => {
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
  const elapsed = Date.now() - startedAt, deadline = Date.parse(answer.validUntil)
  // Named, so debug mode can say which check failed; the names describe this request, never its content.
  const failed = Object.entries({
    connection_changed: current.executorId !== before.executorId || current.connectionEpoch !== before.connectionEpoch
      || current.apiBaseUrl !== before.apiBaseUrl || current.machinePublicKey !== before.machinePublicKey
      || current.sessionPairingSource?.kind !== 'bound'
      || current.sessionPairingSource.originalOwnerGeneration !== scope.originalOwnerGeneration
      || answer.connectionEpoch !== current.connectionEpoch,
    answer_for_another_request: answer.commandId !== scope.commandId || answer.selectionDigest !== selectionDigest
      || answer.phase !== phase || answer.requestNonce !== payload.requestNonce
      || answer.requestDigest !== requestDigest,
    authorization_changed: answer.authorizationRevision !== scope.authorizationRevision
      || answer.purpose !== scope.purpose,
    deadline_passed: deadline <= Date.now(),
    answer_slower_than_5s: elapsed >= 5_000,
    deadline_beyond_clock_allowance: deadline > Date.now() + 5_000 + CLOCK_ALLOWANCE_MS,
    selection_changed: canonicalExecutorJson(executorCodingSessionResultScope(answer.authority))
      !== canonicalExecutorJson(executorCodingSessionResultScope(scope)),
  }).filter(([, bad]) => bad).map(([name]) => name)
  if (failed.length) throw new Error(`Original session authority changed (${failed.join(', ')}; ${elapsed} ms)`)
  return { carrier: answer.authority,
    permit: { ...answer.authority, expiresAt: new Date(Math.min(Date.parse(answer.authority.expiresAt),
      Date.parse(answer.validUntil), startedAt + 5_000)).toISOString() } }
}
