import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as SqlClient from 'effect/sql/SqlClient'
import { ProjectionStore } from '@nessie/t3-session-source/engine'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3CatalogMetadataPageSchema, T3CatalogPublicationSchema,
  type T3CatalogMetadataPage, type T3CatalogPublicationReceipt } from '@nessie/executor-protocol/t3-session'
import { createT3CatalogPublicationTransport } from '../../t3-catalog-publication.js'
import type { ExecutorLocalState } from '../../state-store.js'
import type { RetainedCapturePorts } from '../import/capture.js'
import type { T3CatalogPublicationPort } from '../import/manifest.js'
import type { RetainedImportLocalContext } from '../ownership/import-scope.js'
import type { RetainedCatalogPublicationAuthorityPort } from './selection.js'
import type { HeldRetainedReadGraph } from './scope.js'
import { requireCapture } from '../state/sqlite.js'
import { capturedCatalogPage, type CapturedCatalogCursor } from './publication-rows.js'
import { withRetainedCatalogPublication, type HeldCatalogPublication, type LocalCatalogCapture } from './publication-scope.js'

/** Enumerate twice under one captured-database transaction: the first pass pins
 * counts/digest before any server mutation, the second sends precisely those
 * bounded pages. Only one page is retained. Retry sends the same page ordinals;
 * T07 reconciles committed receipts, never appends a guessed suffix.
 */
const enumerate = (held: HeldCatalogPublication, input: LocalCatalogCapture,
  accept?: (page: T3CatalogMetadataPage) => Promise<void>) => Effect.gen(function* () {
  const digest = createHash('sha256').update('nessie.t3.catalog.metadata.v1\0').update(canonicalExecutorJson({
    source: held.source, captureGeneration: input.captureGeneration, sourceHighWater: input.sourceHighWater,
    sourceSnapshotDigest: held.sourceSnapshotDigest, selection: held.selection, selectionKey: held.selectionKey,
  })).update('\0')
  let cursor: CapturedCatalogCursor | undefined
  let totalPages = 0
  let totalEntries = 0
  const counts = { active: 0, archived: 0, deleted: 0 }
  while (true) {
    yield* Effect.promise(() => held.recheck())
    const rows = yield* capturedCatalogPage(held.selection, cursor)
    if (rows.entries.length === 0) break
    const entries: T3CatalogMetadataPage['entries'] = []
    for (const [index, row] of rows.entries.entries()) {
      held.checkIdentity(row.threadId)
      entries.push({ threadId: row.threadId, sourceState: row.state,
        // This is the original source index, not a persisted copy of a person's
        // mobile grouping preferences. Original client reducers own that view.
        groupPath: [held.source.environmentId], groupOrdinal: 0, rowOrdinal: totalEntries + index,
        mapping: { title: row.title, sourceStorageKey: row.threadId,
          sourceSchemaVersion: ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
          sourceMigrationRef: null, projectRef: row.projectId } })
      counts[row.state]++
    }
    const page = T3CatalogMetadataPageSchema.parse({ pageOrdinal: totalPages, firstEntry: totalEntries, entries })
    const bytes = canonicalExecutorJson(page)
    requireCapture(Buffer.byteLength(bytes, 'utf8') <= 1024 * 1024, 'capture_publication_page_too_large')
    digest.update(bytes).update('\0')
    if (accept) {
      yield* Effect.promise(() => held.recheck())
      yield* Effect.promise(() => accept(page))
      yield* Effect.promise(() => held.recheck())
    }
    totalPages++
    totalEntries += entries.length
    cursor = rows.next
  }
  if (held.selection.scope === 'threads') {
    requireCapture(totalEntries === held.selection.threadIds.length, 'capture_publication_selection_incomplete')
  }
  return Object.freeze({ totalPages, totalEntries, counts: Object.freeze(counts),
    snapshotDigest: `sha256:${digest.digest('hex')}` })
})

/** Actual local-reference-to-signed-publication adapter. Runtime supplies its
 * already admitted state accessor and real producer ports. This function never
 * constructs a source-owner or UOA authority from a callback, grant ID or path.
 * T07's signed transport and protocol are required parent-integrated inputs.
 */
export function createRetainedCatalogPublicationPort(ports: RetainedCapturePorts,
  local: RetainedImportLocalContext, graph: HeldRetainedReadGraph,
  authority: RetainedCatalogPublicationAuthorityPort, state: () => ExecutorLocalState): T3CatalogPublicationPort {
  return Object.freeze({
    async publishLocalCapture(requested: LocalCatalogCapture, options?: { readonly signal?: AbortSignal }) {
      const input = Object.freeze({ ...requested, source: Object.freeze({ ...requested.source }) })
      // Finite bounded attempt. A timeout leaves server staging/receipts intact;
      // a later explicit retry reconciles the same immutable publication/pages.
      const deadline = AbortSignal.timeout(120_000)
      const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline
      return withRetainedCatalogPublication(ports, local, graph, authority, input, signal, async held => {
        const exit = await graph.evaluate(Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(Effect.gen(function* () {
            const snapshot = yield* enumerate(held, input)
            const publication = T3CatalogPublicationSchema.parse({ environmentId: held.source.environmentId,
              physicalRootKey: held.source.physicalRootKey, captureGeneration: input.captureGeneration,
              selectionKey: held.selectionKey, sourceHighWater: String(input.sourceHighWater),
              snapshotDigest: snapshot.snapshotDigest, totalPages: snapshot.totalPages,
              totalEntries: snapshot.totalEntries,
              scope: held.selection.scope === 'environment-owner' ? 'source' : 'selection' })
            yield* Effect.promise(() => held.recheck())
            const transport = createT3CatalogPublicationTransport(state, held.publicationGrantId, publication)
            let publicationId: string | undefined
            const checkReceipt = (receipt: T3CatalogPublicationReceipt) => {
              requireCapture(receipt.state !== 'invalidated' &&
                (publicationId === undefined || publicationId === receipt.publicationId) &&
                receipt.nextPage <= snapshot.totalPages && receipt.nextEntry <= snapshot.totalEntries,
              'capture_publication_receipt_mismatch')
              publicationId = receipt.publicationId
            }
            const delivered = yield* enumerate(held, input, async page => {
              checkReceipt(await transport.page(page, signal))
            })
            requireCapture(canonicalExecutorJson(snapshot) === canonicalExecutorJson(delivered),
              'capture_publication_snapshot_changed')
            yield* Effect.promise(() => held.recheck())
            const receipt = yield* Effect.promise(() => transport.complete(signal))
            checkReceipt(receipt)
            requireCapture(receipt.nextPage === snapshot.totalPages && receipt.nextEntry === snapshot.totalEntries,
              'capture_publication_completion_mismatch')
            yield* Effect.promise(() => held.recheck())
            return Object.freeze(receipt)
          }))
        }), signal)
        return Effect.runPromise(Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value))
      })
    },
  })
}
