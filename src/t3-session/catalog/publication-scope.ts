import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { RetainedCapturePorts } from '../import/capture.js'
import type { OwnedCaptureStage } from '../import/materialize.js'
import type { ProvenT3Source, T3SourceManifest } from '../import/manifest.js'
import type { RetainedCatalogSelection } from './selection.js'
import { pinCatalogSelection } from './selection.js'
import { requireCapture } from '../state/sqlite.js'

export interface LocalCatalogCapture {
  readonly source: ProvenT3Source
  readonly captureGeneration: string
  readonly sourceHighWater: number
  /** Executor-local journal stage reference. Never a server-readable URL/path. */
  readonly localCatalogReference: string
}

export interface HeldCatalogPublication {
  readonly source: ProvenT3Source
  readonly stage: OwnedCaptureStage
  readonly selection: RetainedCatalogSelection
  readonly publicationGrantId: string
  readonly selectionKey: string
  readonly sourceSnapshotDigest: string
  recheck(): Promise<void>
  recheckThread(threadId: string): Promise<void>
}

/** Publication executes inside both real producer leases. No caller-provided
 * recheck can stand in for either producer. The input reference is resolved only
 * through this journal's exact published generation, never as an arbitrary path.
 */
export async function withRetainedCatalogPublication<A>(ports: RetainedCapturePorts,
  manifest: T3SourceManifest, requested: LocalCatalogCapture, signal: AbortSignal,
  use: (held: HeldCatalogPublication) => Promise<A>): Promise<A> {
  const input = Object.freeze({ ...requested, source: Object.freeze({ ...requested.source }) })
  const sourceOwner = ports.source
  const authority = ports.catalogPublicationAuthority
  requireCapture(sourceOwner && authority, 'required_retained_publication_producers')
  signal.throwIfAborted()
  requireCapture(manifest.homes.some(home => home.admittedRootKey === input.source.admittedRootKey),
    'source_not_in_manifest')
  const result = await sourceOwner.withReadonlySource(manifest, input.source.admittedRootKey,
    async (proven, _database, physicalSourceRecheck) => {
      requireCapture(proven.admittedRootKey === input.source.admittedRootKey &&
        proven.physicalRootKey === input.source.physicalRootKey && proven.environmentId === input.source.environmentId &&
        proven.layout === input.source.layout && proven.databaseRole === input.source.databaseRole,
      'capture_source_mismatch')
      return authority.withCatalogPublicationScope({ source: proven, physicalSourceRecheck,
        captureGeneration: input.captureGeneration, purpose: 'retained-catalog-publish' }, async lease => {
        const selection = pinCatalogSelection(lease.selection)
        const recheck = async () => {
          signal.throwIfAborted()
          await physicalSourceRecheck()
          await lease.recheckSource()
          await lease.recheckSelection()
          signal.throwIfAborted()
          const root = ports.journal.root(proven.physicalRootKey)
          requireCapture(root?.environment_id === proven.environmentId, 'capture_source_mismatch')
          ports.journal.requirePublished(proven.physicalRootKey, input.captureGeneration)
          const current = ports.journal.generation(input.captureGeneration)
          requireCapture(current?.stage_ref === input.localCatalogReference &&
            current.source_high_water === input.sourceHighWater, 'capture_publication_reference_mismatch')
        }
        await recheck()
        const snapshot = ports.journal.snapshot(input.captureGeneration)
        requireCapture(typeof snapshot?.digest === 'string', 'capture_snapshot_provenance_missing')
        const stage = await ports.workspace.reopenGeneration(input.localCatalogReference)
        requireCapture(stage.reference === input.localCatalogReference, 'capture_stage_mismatch')
        await recheck()
        const granted = selection.scope === 'threads' ? new Set<string>(selection.threadIds) : undefined
        const outcome = await use({ source: proven, stage, selection, sourceSnapshotDigest: snapshot.digest,
          publicationGrantId: lease.publicationGrantId, selectionKey: lease.selectionKey,
          recheck, recheckThread: async threadId => {
            signal.throwIfAborted()
            requireCapture(!granted || granted.has(threadId), 'capture_publication_thread_forbidden')
            const row = ports.journal.catalogIdentity(proven.physicalRootKey, threadId)
            requireCapture(row?.seen_generation === input.captureGeneration, 'capture_publication_identity_missing')
            // IDs retain their original spelling; the canonical lease validates
            // consent independently of the journal's product metadata.
            await lease.recheckThread(S.ThreadId.make(threadId))
          } })
        await recheck()
        return outcome
      })
    })
  signal.throwIfAborted()
  ports.journal.requirePublished(input.source.physicalRootKey, input.captureGeneration)
  return result
}
