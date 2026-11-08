import { ExecutorCodingSessionAuthoritySchema, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { loadExecutorState } from '../state-store.js'
import { createSessionAuthorityClient } from '../session-authority-client.js'
import { requireManagedSessionEvidence } from './session-authority.js'
import type { CodingSessionMeta, CodingSessionRequest } from './types.js'
import { assertVerifiedT3EffectGrant, createT3EffectAuthorityClient,
  type VerifiedT3EffectGrant } from '../t3-effect-authority-client.js'
import { exactHttpsOrigin, isT3EffectScope, parseSessionEffectScope, sameT3EffectOperation,
  type SessionEffectScope } from './session-effect-scope.js'

/** Only the inherited-reference parser can construct this deferred selection; consumption still requires the signed route. */
class InheritedT3Selection {
  constructor(readonly scope: SessionEffectScope, readonly issuerOrigin: string) {}
}

export class SessionEffectRefused extends Error {
  constructor() { super('Original session effect authority is unavailable; reconcile the retained intent.') }
}

/** Only the signed owning route can refresh this lease. Never serialize a callback or a local extension. */
export class SessionEffectAuthority {
  #scope: SessionEffectScope
  readonly #issuerOrigin?: string
  constructor(private readonly directory: string,
    scope: ExecutorCodingSessionAuthority | VerifiedT3EffectGrant | InheritedT3Selection) {
    if (scope instanceof InheritedT3Selection) {
      this.#scope = scope.scope
      this.#issuerOrigin = scope.issuerOrigin
    }
    else {
      const managed = ExecutorCodingSessionAuthoritySchema.safeParse(scope)
      if (managed.success) this.#scope = managed.data
      else {
        assertVerifiedT3EffectGrant(scope)
        this.#scope = parseSessionEffectScope(scope.reference)
        if (!exactHttpsOrigin(scope.issuerOrigin)) throw new SessionEffectRefused()
        this.#issuerOrigin = scope.issuerOrigin
      }
    }
  }

  get issuerOrigin(): string | undefined { return this.#issuerOrigin }

  get reference(): { directory: string; authority: SessionEffectScope; issuerOrigin?: string } {
    return { directory: this.directory, authority: this.scope,
      ...(this.#issuerOrigin ? { issuerOrigin: this.#issuerOrigin } : {}) }
  }

  static fromReference(value: unknown): SessionEffectAuthority | undefined {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || !('directory' in value) || typeof value.directory !== 'string'
      || !('authority' in value)) throw new SessionEffectRefused()
    const scope = parseSessionEffectScope(value.authority)
    if (isT3EffectScope(scope)) {
      if (!('issuerOrigin' in value) || !exactHttpsOrigin(value.issuerOrigin)) throw new SessionEffectRefused()
      return new SessionEffectAuthority(value.directory, new InheritedT3Selection(scope, value.issuerOrigin))
    }
    return new SessionEffectAuthority(value.directory, scope)
  }

  get scope(): SessionEffectScope { return structuredClone(this.#scope) }

  assertLive(): void {
    if (Date.parse(this.#scope.expiresAt) <= Date.now()
      || Date.parse(this.#scope.issuedAt) > Date.now() + 2_000) throw new SessionEffectRefused()
  }

  async consume(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.assertLive()
    try {
      const state = await loadExecutorState(this.directory)
      this.assertLive()
      if (isT3EffectScope(this.#scope)) {
        const original = this.#scope
        if (this.#issuerOrigin !== new URL(state.apiBaseUrl).origin
          || state.executorId !== original.executorId || state.connectionEpoch !== original.connectionEpoch) {
          throw new SessionEffectRefused()
        }
        const grant = await createT3EffectAuthorityClient(() => state).request(original, signal)
        assertVerifiedT3EffectGrant(grant)
        const renewed = grant.reference
        const current = await loadExecutorState(this.directory)
        if (grant.issuerOrigin !== this.#issuerOrigin || !sameT3EffectOperation(original, renewed)
          || current.executorId !== original.executorId
          || current.connectionEpoch !== original.connectionEpoch || current.executorId !== state.executorId
          || current.machinePublicKey !== state.machinePublicKey || current.apiBaseUrl !== state.apiBaseUrl) {
          throw new SessionEffectRefused()
        }
        signal?.throwIfAborted()
        this.assertLive()
        this.#scope = renewed
        this.assertLive()
        return
      }
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

/** The original adapter hands over a cryptographically verified finite grant, never a raw selection. */
export const requestT3EffectAuthority = async (
  directory: string, grant: VerifiedT3EffectGrant, signal?: AbortSignal,
): Promise<SessionEffectAuthority> => {
  assertVerifiedT3EffectGrant(grant)
  const effect = new SessionEffectAuthority(directory, grant)
  // Consume from this executor's current enrolled state, not a captured or caller-selected origin.
  await effect.consume(signal)
  return effect
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
