import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import type { RetainedCatalogSelection } from './selection.js'
import { requireCapture } from '../state/sqlite.js'

export const RETAINED_PUBLICATION_PAGE_SIZE = 128

export interface CapturedCatalogEntry {
  readonly threadId: S.ThreadId
  readonly state: 'active' | 'archived' | 'deleted'
  readonly title: string
  readonly projectId: S.ProjectId | null
}

export interface CapturedCatalogCursor {
  readonly updatedAt: string
  readonly threadId: string
}

/** Metadata pagination over the already materialized original projection. The
 * original ProjectionStore.selectShellThreadRows order is updated_at ASC then
 * thread_id ASC (SQLite binary UTF-8 ties). This is not a shell/history reducer:
 * it transports identity membership and source index metadata, including
 * tombstones, without transcript, provider or inherited-resource reads. Source UI reducers still
 * own grouping. No OFFSET, local timestamp window or total-catalog truncation.
 *
 * Call inside one destination read transaction for the complete publication.
 */
export const capturedCatalogPage = (selection: RetainedCatalogSelection,
  after?: CapturedCatalogCursor) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const selectedIds = selection.scope === 'threads' ? JSON.stringify(selection.threadIds) : undefined
  const rows = yield* sql<{
    thread_id: string; updated_at: string; archived_at: string | null; deleted_at: string | null
    title: string; project_id: string
  }>`SELECT t.thread_id, t.updated_at, t.archived_at, t.deleted_at,
    json_extract(t.payload_json, '$.title') AS title, t.project_id
    FROM orchestration_v2_projection_threads t
    WHERE 1 = 1${selectedIds === undefined ? sql``
      : sql` AND t.thread_id IN (SELECT value FROM json_each(${selectedIds}))`}${after === undefined ? sql``
      : sql` AND (t.updated_at > ${after.updatedAt}
        OR (t.updated_at = ${after.updatedAt} AND t.thread_id > ${after.threadId}))`}
    ORDER BY t.updated_at ASC, t.thread_id ASC
    LIMIT ${RETAINED_PUBLICATION_PAGE_SIZE}`
  const entries: CapturedCatalogEntry[] = rows.map(row => {
    requireCapture(typeof row.thread_id === 'string' && typeof row.updated_at === 'string' &&
      typeof row.title === 'string' && typeof row.project_id === 'string',
      'capture_publication_order_invalid')
    return Object.freeze({ threadId: S.ThreadId.make(row.thread_id),
      title: row.title, projectId: selection.scope === 'environment-owner' || selection.projectIds.includes(
        S.ProjectId.make(row.project_id)) ? S.ProjectId.make(row.project_id) : null,
      state: row.deleted_at !== null ? 'deleted' : row.archived_at !== null ? 'archived' : 'active' })
  })
  const last = rows.at(-1)
  return { entries: Object.freeze(entries),
    next: last ? { updatedAt: last.updated_at, threadId: last.thread_id } : undefined }
})
