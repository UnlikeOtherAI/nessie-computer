import type { SourceContracts } from '@nessie/t3-session-source/engine'
import type { CaptureDatabase } from '../state/sqlite.js'

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

/** REQUIRED, UNBOUND. Implement in the existing admitted local-resource boundary.
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

/** REQUIRED, UNBOUND. T07 must serialize with its existing environment/root rows.
 * A local capture receipt is data, never server catalog completion or entitlement.
 */
export interface T3CatalogPublicationPort {
  publishLocalCapture(input: {
    readonly source: ProvenT3Source
    readonly captureGeneration: string
    readonly sourceHighWater: number
    readonly localCatalogReference: string
  }): Promise<void>
}

export const retainedCaptureBindings = Object.freeze({
  localResourceProducer: 'required_unbound',
  originalOwnerContinuityProducer: 'required_unbound',
  serverCatalogPublication: 'required_unbound',
  execution: 'unavailable',
} as const)
