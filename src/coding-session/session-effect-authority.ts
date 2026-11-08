import { ExecutorCodingSessionAuthoritySchema, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { loadExecutorState } from '../state-store.js'
import { createSessionAuthorityClient } from '../session-authority-client.js'
import { requireManagedSessionEvidence } from './session-authority.js'
import type { CodingSessionMeta, CodingSessionRequest } from './types.js'

export class SessionEffectRefused extends Error {
  constructor() { super('Original session effect authority is unavailable; reconcile the retained intent.') }
}

/** Only the signed owning route can refresh this lease. Never serialize a callback or a local extension. */
export class SessionEffectAuthority {
  #scope: ExecutorCodingSessionAuthority
  constructor(private readonly directory: string, scope: ExecutorCodingSessionAuthority) {
    this.#scope = ExecutorCodingSessionAuthoritySchema.parse(scope)
  }

  get reference(): { directory: string; authority: ExecutorCodingSessionAuthority } {
    return { directory: this.directory, authority: this.scope }
  }

  static fromReference(value: unknown): SessionEffectAuthority | undefined {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || !('directory' in value) || typeof value.directory !== 'string'
      || !('authority' in value)) throw new SessionEffectRefused()
    return new SessionEffectAuthority(value.directory, ExecutorCodingSessionAuthoritySchema.parse(value.authority))
  }

  get scope(): ExecutorCodingSessionAuthority { return structuredClone(this.#scope) }

  assertLive(): void {
    if (Date.parse(this.#scope.expiresAt) <= Date.now()
      || Date.parse(this.#scope.issuedAt) > Date.now() + 2_000) throw new SessionEffectRefused()
  }

  async consume(): Promise<void> {
    this.assertLive()
    try {
      const state = await loadExecutorState(this.directory)
      this.assertLive()
      const renewed = await createSessionAuthorityClient(() => state)(this.#scope, 'execute')
      const current = await loadExecutorState(this.directory)
      if (current.executorId !== state.executorId || current.connectionEpoch !== state.connectionEpoch
        || current.machinePublicKey !== state.machinePublicKey || current.apiBaseUrl !== state.apiBaseUrl
        || current.sessionPairingSource?.kind !== 'bound'
        || current.sessionPairingSource.originalOwnerGeneration !== this.#scope.originalOwnerGeneration) {
        throw new SessionEffectRefused()
      }
      // A round trip cannot revive the lease that expired while this effect was waiting.
      this.assertLive()
      this.#scope = renewed
      this.assertLive()
    } catch { throw new SessionEffectRefused() }
  }

}

/** The host consumes the same selected operation; a queue is never an authority renewal. */
export const requestEffectAuthority = (
  directory: string, meta: CodingSessionMeta, request: CodingSessionRequest,
): SessionEffectAuthority | undefined => {
  // System retirement/withdrawal is independent of a human's expired execution carrier.
  if (request.kind === 'retire' || request.kind === 'close' && request.reason !== undefined) return undefined
  if (!meta.originalManagedStart && !request.sessionAuthority) return undefined
  const parsed = ExecutorCodingSessionAuthoritySchema.safeParse(request.sessionAuthority)
  if (!parsed.success || !meta.originalManagedStart) throw new SessionEffectRefused()
  const scope = parsed.data
  if (scope.purpose !== 'control' || scope.ownerKey !== meta.ownerKey
    || scope.executorId !== meta.originalManagedStart.executorId
    || scope.originalOwnerGeneration !== meta.originalManagedStart.originalOwnerGeneration
    || scope.commandId !== (request.kind === 'answer' ? request.id.replace(/^answer-/u, '') : request.id)
    || (scope.operation !== `session_${request.kind}` && !(scope.operation === 'session_user_action'
      && ['send', 'interrupt', 'answer'].includes(request.kind)))) throw new SessionEffectRefused()
  if (request.kind === 'start') {
    if (scope.commandId !== meta.originalManagedStart.startCommandId) throw new SessionEffectRefused()
  } else requireManagedSessionEvidence(scope, meta)
  return new SessionEffectAuthority(directory, scope)
}
