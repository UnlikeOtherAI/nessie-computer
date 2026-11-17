import { withStateSecurityChecks } from '../state-security.js'
import { debugFailure, executorDebugChild } from '../debug-mode.js'
import { canonicalExecutorJson, executorCodingSessionResultScope, ExecutorCodingSessionAuthoritySchema,
  type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { loadExecutorState } from '../state-store.js'
import { createSessionAuthorityClient } from '../session-authority-client.js'
import { requireManagedSessionEvidence } from './session-authority.js'
import type { CodingSessionMeta, CodingSessionRequest } from './types.js'
import { assertVerifiedT3EffectGrant, createT3EffectAuthorityClient,
  type VerifiedT3EffectGrant } from '../t3-effect-authority-client.js'
import { exactHttpsOrigin, isT3EffectScope, parseSessionEffectScope, sameT3EffectOperation,
  type SessionEffectScope } from './session-effect-scope.js'

/** Only the inherited-reference parser constructs this deferred selection.
 * Consumption still requires the signed route. */
class InheritedT3Selection {
  constructor(readonly scope: SessionEffectScope, readonly issuerOrigin: string) {}
}

export class SessionEffectRefused extends Error {
  /** `why` is for the owner's own terminal in debug mode. It never enters the message, a result or a log. */
  constructor(readonly why?: string) {
    super('Original session effect authority is unavailable; reconcile the retained intent.')
  }
}

/** Debug mode names the cause in the process's own stderr; otherwise a refusal says nothing more. */
const explain = (error: unknown): void => {
  if (!executorDebugChild()) return
  const detail = error instanceof SessionEffectRefused ? error.why ?? debugFailure(error) : debugFailure(error)
  process.stderr.write(`[session-effect] debug: refused: ${detail}\n`)
}

const referenceLive = (reference: { issuedAt: string; expiresAt: string }): boolean => (
  Date.parse(reference.expiresAt) > Date.now() && Date.parse(reference.issuedAt) <= Date.now() + 2_000
)

/** Only the signed owning route can refresh this lease. Never serialize a callback or a local extension. */
export class SessionEffectAuthority {
  #scope: SessionEffectScope
  #queuedCarrier?: ExecutorCodingSessionAuthority
  /** The route's reference for this same operation, as the process that handed this over received it. */
  #handedReference?: ExecutorCodingSessionAuthority
  readonly #issuerOrigin?: string
  constructor(private readonly directory: string,
    scope: ExecutorCodingSessionAuthority | VerifiedT3EffectGrant | InheritedT3Selection, reference?: unknown) {
    if (scope instanceof InheritedT3Selection) {
      this.#scope = scope.scope
      this.#issuerOrigin = scope.issuerOrigin
    }
    else {
      const managed = ExecutorCodingSessionAuthoritySchema.safeParse(scope)
      if (managed.success) {
        this.#scope = managed.data
        if (reference !== undefined) {
          // The same selection or nothing: a reference can only ask the route about the operation it names.
          const handed = ExecutorCodingSessionAuthoritySchema.safeParse(reference)
          if (!handed.success || canonicalExecutorJson(executorCodingSessionResultScope(handed.data))
            !== canonicalExecutorJson(executorCodingSessionResultScope(managed.data))) throw new SessionEffectRefused()
          this.#handedReference = handed.data
        }
      }
      else {
        assertVerifiedT3EffectGrant(scope)
        this.#scope = parseSessionEffectScope(scope.reference)
        if (!exactHttpsOrigin(scope.issuerOrigin)) throw new SessionEffectRefused()
        this.#issuerOrigin = scope.issuerOrigin
      }
    }
  }

  get issuerOrigin(): string | undefined { return this.#issuerOrigin }

  get reference(): { directory: string; authority: SessionEffectScope; issuerOrigin?: string
    reference?: ExecutorCodingSessionAuthority } {
    const route = this.#queuedCarrier ?? this.#handedReference
    return { directory: this.directory, authority: this.scope,
      ...(this.#issuerOrigin ? { issuerOrigin: this.#issuerOrigin } : {}),
      ...(route && referenceLive(route) ? { reference: structuredClone(route) } : {}) }
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
    return new SessionEffectAuthority(value.directory, scope, 'reference' in value ? value.reference : undefined)
  }

  get scope(): SessionEffectScope { return structuredClone(this.#scope) }

  /** Retains only the route-issued carrier. A receiving host must consume it for its own effect permit. */
  get queuedCarrier(): ExecutorCodingSessionAuthority {
    this.assertLive()
    if (!this.#queuedCarrier || Date.parse(this.#queuedCarrier.expiresAt) <= Date.now()) {
      throw new SessionEffectRefused()
    }
    return structuredClone(this.#queuedCarrier)
  }

  assertLive(): void {
    if (!referenceLive(this.#scope)) throw new SessionEffectRefused()
  }

  async consume(signal?: AbortSignal): Promise<void> {
    try {
      // An expired reference asks nothing and reads nothing: a dead operation is refused before any I/O.
      if (!isT3EffectScope(this.#scope)
        && !referenceLive(this.#queuedCarrier ?? this.#handedReference ?? this.#scope)) {
        throw new SessionEffectRefused('the route\'s reference ran out before it was asked')
      }
      for (let attempt = 0; ; attempt += 1) {
        await withStateSecurityChecks(() => this.#consume(signal))
        if (referenceLive(this.#scope)) return
        // The route answered and this computer's own checks outlasted the permit, as a busy machine's do.
        // Ask again while the route's reference lasts; never act on the permit that ran out.
        if (attempt === 2 || isT3EffectScope(this.#scope)) {
          throw new SessionEffectRefused('the permit ran out during this computer\'s own checks')
        }
      }
    } catch (error) {
      explain(error)
      throw new SessionEffectRefused()
    }
  }
  async #consume(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    // Every effect asks the route afresh, so a revocation stops the very next one. Only the reference it asks with
    // outlives a permit; see "Session permits on a slow connection".
    if (isT3EffectScope(this.#scope)) this.assertLive()
    try {
      const state = await loadExecutorState(this.directory)
      if (isT3EffectScope(this.#scope)) {
        this.assertLive()
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
      // The route's own reference asks for the next permit: the one it last issued, else the one this began
      // with. A permit lasts five seconds and a reference thirty, so a slow answer or a slow effect costs a
      // round trip, never the operation. Nothing here extends either deadline; only the route issues them.
      const reference = this.#queuedCarrier ?? this.#handedReference ?? this.#scope
      if (!referenceLive(reference)) throw new SessionEffectRefused('the route\'s reference ran out before it was asked')
      const renewed = await createSessionAuthorityClient(() => state)(reference, 'execute')
      const current = await loadExecutorState(this.directory)
      if (current.executorId !== state.executorId || current.connectionEpoch !== state.connectionEpoch
        || current.machinePublicKey !== state.machinePublicKey || current.apiBaseUrl !== state.apiBaseUrl
        || current.sessionPairingSource?.kind !== 'bound'
        || current.sessionPairingSource.originalOwnerGeneration !== reference.originalOwnerGeneration) {
        throw new SessionEffectRefused('this connection changed while the route answered')
      }
      // A round trip cannot revive the reference that expired while this effect was waiting.
      if (!referenceLive(reference)) throw new SessionEffectRefused('the route\'s reference ran out while it answered')
      // Whether this permit is still live is `consume`'s question: it asks again when these reads outlasted it.
      this.#scope = renewed.permit
      this.#queuedCarrier = renewed.carrier
    } catch (error) {
      if (error instanceof SessionEffectRefused) throw error
      throw new SessionEffectRefused(debugFailure(error))
    }
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
