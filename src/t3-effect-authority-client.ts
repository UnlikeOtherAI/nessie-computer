import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { z } from 'zod'
import { canonicalExecutorJson, canonicalExecutorPayload } from '@nessie/executor-protocol'
import { T3EffectGrantReferenceSchema, T3EffectSelectionSchema, T3EffectAuthorityCheckedSchema,
  T3_EFFECT_SIGNATURE_DOMAIN, t3EffectSelection,
  type T3EffectGrantReference, type T3EffectSelection } from '@nessie/executor-protocol/t3-session'
import { executorApi } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

const verified = new WeakSet<object>()
const issuanceToken = Symbol('verified T3 effect issuance')
const keysSchema = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('RSA'),
  n: z.string(), e: z.string(), alg: z.literal('RS256'), use: z.literal('sig'),
}).passthrough()).min(1).max(16) })
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`
const refused = () => new Error('T3_EFFECT_AUTHORITY_REFUSED')

class FiniteGrant {
  readonly #value: T3EffectGrantReference
  readonly #renew: (value: T3EffectGrantReference, signal?: AbortSignal) => Promise<VerifiedT3EffectGrant>
  constructor(token: typeof issuanceToken, value: T3EffectGrantReference, readonly issuerOrigin: string,
    renew: (value: T3EffectGrantReference, signal?: AbortSignal) => Promise<VerifiedT3EffectGrant>) {
    if (token !== issuanceToken) throw refused()
    this.#value = structuredClone(value)
    this.#renew = renew
    verified.add(this)
    Object.freeze(this)
  }
  get reference(): T3EffectGrantReference { return structuredClone(this.#value) }
  async consume(signal?: AbortSignal): Promise<VerifiedT3EffectGrant> {
    assertVerifiedT3EffectGrant(this)
    return this.#renew(this.reference, signal)
  }
}
export type VerifiedT3EffectGrant = FiniteGrant
Object.freeze(FiniteGrant.prototype)
/** A native receiver additionally compares issuerOrigin to its protected enrolled
 * backend. A branded grant from a different installation is not interchangeable.
 */
export function assertVerifiedT3EffectGrant(value: unknown): asserts value is VerifiedT3EffectGrant {
  if (!value || typeof value !== 'object' || !verified.has(value)) throw refused()
  const grant = (value as FiniteGrant).reference
  if (Date.parse(grant.expiresAt) <= Date.now() || Date.parse(grant.issuedAt) > Date.now() + 2_000) throw refused()
}

/** Existing enrolled backend + daemon key, never a key embedded in a grant.
 * TLS authenticates the fixed JWKS endpoint; RS256 authenticates the finite grant.
 */
export function createT3EffectAuthorityClient(state: () => ExecutorLocalState) {
  const issue = async (value: T3EffectSelection, signal?: AbortSignal): Promise<VerifiedT3EffectGrant> => {
    const selection = T3EffectSelectionSchema.parse(value)
    const before = state()
    const origin = new URL(before.apiBaseUrl)
    if (origin.protocol !== 'https:' || origin.username || origin.password
      || before.executorId !== selection.executorId || before.connectionEpoch !== selection.connectionEpoch) throw refused()
    const started = Date.now()
    const payload = { executorId: before.executorId, connectionEpoch: selection.connectionEpoch,
      selection, observedAt: new Date(started).toISOString(), requestNonce: randomUUID() }
    const options = { signal, timeoutMs: 5_000 }
    const [result, keys] = await Promise.all([
      executorApi.checkT3EffectAuthority(before.apiBaseUrl, { ...payload,
        signature: signExecutorDaemonPayload(before.machinePrivateKey, 't3_effect_authority', payload) }, options),
      executorApi.t3EffectIssuerKeys(before.apiBaseUrl, options),
    ])
    signal?.throwIfAborted()
    const response = T3EffectAuthorityCheckedSchema.parse(result)
    const matches = keysSchema.parse(keys).keys.filter(key => key.kid === response.keyId)
    if (matches.length !== 1) throw refused()
    const key = matches[0]!
    if (!verify('RSA-SHA256', Buffer.from(canonicalExecutorPayload(T3_EFFECT_SIGNATURE_DOMAIN, response.grant)),
      createPublicKey({ format: 'jwk', key: { kty: key.kty, n: key.n, e: key.e } }),
      Buffer.from(response.signature, 'base64url'))) throw refused()
    const current = state()
    const grant = response.grant
    if (current.apiBaseUrl !== before.apiBaseUrl || current.executorId !== before.executorId
      || current.connectionEpoch !== before.connectionEpoch || current.machinePublicKey !== before.machinePublicKey
      || grant.requestNonce !== payload.requestNonce || grant.requestProofDigest !== digest(payload)
      || canonicalExecutorJson(t3EffectSelection(grant)) !== canonicalExecutorJson(selection)
      || Date.now() - started >= 5_000 || Date.parse(grant.issuedAt) < started - 2_000
      || Date.parse(grant.issuedAt) > Date.now() + 2_000 || Date.parse(grant.expiresAt) <= Date.now()
      || Date.parse(grant.expiresAt) > started + 5_000) throw refused()
    return new FiniteGrant(issuanceToken, grant, origin.origin, request)
  }
  const request = async (value: T3EffectGrantReference, signal?: AbortSignal): Promise<VerifiedT3EffectGrant> => {
    const reference = T3EffectGrantReferenceSchema.parse(value)
    if (Date.parse(reference.expiresAt) <= Date.now()) throw refused()
    const grant = await issue(t3EffectSelection(reference), signal)
    if (Date.parse(reference.expiresAt) <= Date.now()) throw refused()
    return grant
  }
  return { issue, request }
}
