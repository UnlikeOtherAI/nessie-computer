import type { SourceContracts } from '@nessie/t3-session-source/engine'
import type { ProvenT3Source } from '../import/manifest.js'

/** REQUIRED, UNBOUND. T03C's immutable accepted managed-start admissions do not
 * establish the original human for legacy/native/external retained sessions.
 * Neither today's caller nor computer administration, inventory or raw generation
 * can construct this evidence. A1 read and A0 execution custody are separate.
 */
export interface RetainedReadScope {
  /** Opaque callback-scoped functions supplied by the canonical producer.
   * Recheck current revocation and original source/owner generation, with read
   * freshness <=60s. They cannot be reconstructed from serialized references.
   */
  recheckSource(): Promise<void>
  recheckThread(threadId: SourceContracts.ThreadId): Promise<void>
}
export interface RetainedOriginalOwnerPort {
  withReadScope<A>(input: {
    readonly source: ProvenT3Source
    /** Exact live function issued by the resource producer, recognized by the
     * canonical producer's in-process resource binding. Arbitrary functions or
     * serialized source/reference/expiry values must be refused by that producer.
     */
    readonly physicalSourceRecheck: () => Promise<void>
    readonly captureGeneration: string
    readonly purpose: 'retained-history-read'
  }, use: (lease: RetainedReadScope) => Promise<A>): Promise<A>
}

/** REQUIRED native-resource proof, not inferred from paths or provider-instance IDs. */
export interface NativeHistoryHomePort {
  proveHomes(input: {
    readonly source: ProvenT3Source
    readonly providerThread: SourceContracts.OrchestrationV2ProviderThread
  }): Promise<{
    readonly continuationHomeKey: string
    readonly historyHomeKey: string
    readonly homeProofReference: string
  } | undefined>
}

export interface NativeHistoryAlias {
  readonly threadId: string
  readonly providerThreadId: string
  readonly driver: string
  readonly nativeId: string
  readonly strength: 'strong' | 'weak' | 'none'
  readonly continuationHomeKey: string
  readonly historyHomeKey: string
  readonly homeProofReference: string
}

/** Discovery returns every original app identity. It never elects a writer. */
export function describeAliasCandidates(candidates: readonly NativeHistoryAlias[]): {
  readonly state: 'missing' | 'unproven' | 'one-app-history' | 'ambiguous'
  readonly candidates: readonly NativeHistoryAlias[]
  readonly control: 'unavailable'
} {
  const apps = new Set(candidates.map(candidate => candidate.threadId))
  const homes = new Set(candidates.map(candidate => JSON.stringify([
    candidate.continuationHomeKey, candidate.historyHomeKey,
  ])))
  const state = candidates.length === 0 ? 'missing'
    : candidates.some(candidate => candidate.strength !== 'strong') ? 'unproven'
      : apps.size > 1 || homes.size > 1 ? 'ambiguous' : 'one-app-history'
  return { state, candidates, control: 'unavailable' }
}
