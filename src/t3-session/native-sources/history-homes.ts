import type { SourceContracts } from '@nessie/t3-session-source/engine'
import type { ProvenT3Source } from '../import/manifest.js'
import type { NativeHistoryHomePort } from '../ownership/continuity.js'

export interface NativeHistoryHomeTarget {
  readonly source: ProvenT3Source
  readonly providerThread: SourceContracts.OrchestrationV2ProviderThread
}

export interface NativeHistoryResourceLease {
  readonly admittedRootKey: string
  readonly physicalRootKey: string
  readonly environmentId: string
  readonly providerThreadId: string
  readonly appThreadId: string
  readonly driver: string
  readonly nativeId: string
  readonly continuationHomeKey: string
  readonly historyHomeKey: string
  readonly homeProofReference: string
  /** The resource owner holds both homes and checks current admission, physical
   * replacement and exact association for the entire callback. This is NOT a
   * caller-supplied assertion that a path is trusted. */
  recheck(): Promise<void>
}

/** REQUIRED, UNBOUND canonical resource producer. No path/label/credential or
 * heartbeat receipt implements this authority. A production implementation must
 * recognize the resource owner's live in-process lease and exact original T3
 * association; deserializing this interface cannot establish that proof.
 * Codex and Claude share this seam. It grants neither history reads nor control.
 */
export interface NativeHistoryResourcePort {
  withHomes<A>(target: NativeHistoryHomeTarget,
    use: (lease: NativeHistoryResourceLease) => Promise<A>): Promise<A | undefined>
}

/** Consumer of the resource producer, never a proof mint or an ownership election. */
export function bindNativeHistoryHomes(resources?: NativeHistoryResourcePort): NativeHistoryHomePort {
  return { proveHomes: async target => {
    const ref = target.providerThread.nativeThreadRef
    if (!resources || !target.providerThread.appThreadId || !ref?.nativeId) return undefined
    return resources.withHomes(target, async lease => {
      await lease.recheck()
      if (lease.admittedRootKey !== target.source.admittedRootKey
        || lease.physicalRootKey !== target.source.physicalRootKey
        || lease.environmentId !== target.source.environmentId
        || lease.providerThreadId !== target.providerThread.id
        || lease.appThreadId !== target.providerThread.appThreadId
        || lease.driver !== ref.driver || lease.driver !== target.providerThread.driver
        || lease.nativeId !== ref.nativeId
        || !lease.continuationHomeKey || !lease.historyHomeKey || !lease.homeProofReference) {
        throw new Error('native_history_home_affinity_mismatch')
      }
      // Keep independent history overlays even when continuation homes coincide.
      const proof = Object.freeze({ continuationHomeKey: lease.continuationHomeKey,
        historyHomeKey: lease.historyHomeKey, homeProofReference: lease.homeProofReference })
      await lease.recheck()
      return proof
    })
  } }
}
