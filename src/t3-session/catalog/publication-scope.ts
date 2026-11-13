import type { RetainedCapturePorts } from '../import/capture.js'
import type { ProvenT3Source } from '../import/manifest.js'
import type { RetainedImportLocalContext } from '../ownership/import-scope.js'
import type { RetainedCatalogSelection, RetainedCatalogPublicationAuthorityPort } from './selection.js'
import { pinCatalogSelection } from './selection.js'
import type { HeldRetainedReadGraph } from './scope.js'
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
  readonly selection: RetainedCatalogSelection
  readonly publicationGrantId: string
  readonly selectionKey: string
  readonly sourceSnapshotDigest: string
  recheck(): Promise<void>
  checkIdentity(threadId: string): void
}

/** Consume the actual held source and publication-purpose authority. Neither
 * the physical source nor destination SQL is opened here. Runtime calls only
 * inside withHeldRetainedCatalogGraph, itself inside withRetainedImportLocally.
 */
export async function withRetainedCatalogPublication<A>(ports: Pick<RetainedCapturePorts, 'journal'>,
  local: RetainedImportLocalContext, graph: HeldRetainedReadGraph, authority: RetainedCatalogPublicationAuthorityPort,
  requested: LocalCatalogCapture, signal: AbortSignal, use: (held: HeldCatalogPublication) => Promise<A>): Promise<A> {
  const input = Object.freeze({ ...requested, source: Object.freeze({ ...requested.source }) })
  const proven = local.source
  signal.throwIfAborted()
  await graph.recheck()
  requireCapture(graph.source === proven && graph.physicalSourceRecheck === local.physicalSourceRecheck &&
    proven.admittedRootKey === input.source.admittedRootKey
    && proven.physicalRootKey === input.source.physicalRootKey &&
    proven.environmentId === input.source.environmentId && proven.layout === input.source.layout &&
    proven.databaseRole === input.source.databaseRole && input.captureGeneration === local.captureGeneration,
  'capture_source_mismatch')
  const result = await authority.withCatalogPublicationScope({ source: proven,
    physicalSourceRecheck: local.physicalSourceRecheck, captureGeneration: input.captureGeneration,
    purpose: 'retained-catalog-publish' }, async lease => {
    const selection = pinCatalogSelection(lease.selection)
    const recheck = async () => {
      signal.throwIfAborted()
      await graph.recheck()
      // Publication selection revalidation covers the source/import grant and
      // every selected share. Do not perform an HTTP lease exchange per row in
      // a whole-source catalog; T07 also consumes that selection for each page.
      await lease.recheckSelection()
      await graph.recheck()
      signal.throwIfAborted()
      ports.journal.requirePublished(proven.physicalRootKey, input.captureGeneration)
      const current = ports.journal.generation(input.captureGeneration)
      requireCapture(current?.stage_ref === input.localCatalogReference &&
        current.stage_ref === graph.stageReference && current.source_high_water === input.sourceHighWater,
      'capture_publication_reference_mismatch')
    }
    await recheck()
    const snapshot = ports.journal.snapshot(input.captureGeneration)
    requireCapture(typeof snapshot?.digest === 'string', 'capture_snapshot_provenance_missing')
    const granted = selection.scope === 'threads' ? new Set<string>(selection.threadIds) : undefined
    const outcome = await use({ source: proven, selection, sourceSnapshotDigest: snapshot.digest,
      publicationGrantId: lease.publicationGrantId, selectionKey: lease.selectionKey, recheck,
      checkIdentity: threadId => {
        signal.throwIfAborted()
        requireCapture(!granted || granted.has(threadId), 'capture_publication_thread_forbidden')
        const row = ports.journal.catalogIdentity(proven.physicalRootKey, threadId)
        requireCapture(row?.seen_generation === input.captureGeneration, 'capture_publication_identity_missing')
      } })
    await recheck()
    return outcome
  })
  // The owner can perform asynchronous validation after its callback returns.
  await graph.recheck()
  signal.throwIfAborted()
  ports.journal.requirePublished(proven.physicalRootKey, input.captureGeneration)
  return result
}
