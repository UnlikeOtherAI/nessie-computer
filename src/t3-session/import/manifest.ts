import type { SourceContracts } from '@nessie/t3-session-source/engine'
import type { CaptureDatabase } from '../state/sqlite.js'
import type { T3CatalogPublicationReceipt } from '@nessie/executor-protocol/t3-session'

/** These are explicit resource admissions, never filesystem search locations. */
export interface T3SourceManifest {
  readonly revision: string
  readonly homes: readonly {
    readonly admittedRootKey: string
    readonly kind: 'desktop-userdata' | 'desktop-development' | 'server-home' | 'configured-home'
  }[]
}

export interface ProvenT3Source {
  readonly admittedRootKey: string
  readonly physicalRootKey: string
  readonly environmentId: SourceContracts.EnvironmentId
  readonly layout: 'v2-80' | 'legacy-54'
  /** The producer chooses v2 when present. T04 never combines neighboring databases. */
  readonly databaseRole: 'authoritative-v2' | 'sole-legacy'
}

/** Windows implementation: daemon-owned source/owner.ts and the held native reader.
 * The producer owns OS file identity, alias equivalence, replacement/symlink fencing,
 * owner-only access and the persisted environment-id file. Paths/IDs cannot mint proof.
 */
export interface AdmittedT3SourcePort {
  withReadonlySource<A>(
    manifest: T3SourceManifest,
    admittedRootKey: string,
    use: (source: ProvenT3Source, database: CaptureDatabase,
      recheckPhysicalSource: () => Promise<void>) => Promise<A>,
  ): Promise<A>
}

/** Implemented by createRetainedCatalogPublicationPort using the held generation
 * and T07 signed transport. Runtime must supply actual publication authority.
 * A local reference is resolved here, never sent to the server for dereferencing.
 */
export interface T3CatalogPublicationPort {
  publishLocalCapture(input: {
    readonly source: ProvenT3Source
    readonly captureGeneration: string
    readonly sourceHighWater: number
    readonly localCatalogReference: string
  }, options?: { readonly signal?: AbortSignal }): Promise<T3CatalogPublicationReceipt>
}

export const retainedCaptureBindings = Object.freeze({
  localResourceProducer: 'windows_source_implemented_unqualified',
  originalOwnerContinuityProducer: 'required_unbound',
  serverCatalogPublication: 'ordered_producer_implemented_unqualified',
  execution: 'unavailable',
} as const)
