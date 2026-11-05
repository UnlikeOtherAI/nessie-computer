import {
  EXECUTOR_FOLDER_SYNC_ERROR_CODES,
  type FolderSyncChangesResponse,
  type FolderSyncCursors,
  type FolderSyncSnapshotResponse,
  type SyncExcludedSpace,
} from '@nessie/executor-protocol'

import type { EngineStore } from './engine-store.js'
import { applyChanges, isOwnEcho, manifestFromSnapshot } from './reconcile-manifest.js'
import type { RemoteManifest } from './reconcile-model.js'
import { syncErrorCode, type FolderSyncTransport } from './transport.js'

/**
 * Remote truth (plan §2.5, §2.7, A12.7): a paged snapshot at start, on an
 * expired cursor or a space change, and on every sixth reconcile; otherwise the
 * journal rows after the per-space cursors. The manifest and the cursors it
 * implies are written in one index write.
 */

const SNAPSHOT_ATTEMPTS = 3
const CHANGE_PAGES_PER_PULL = 50

export type PullResult = {
  /** Something arrived that this computer did not write itself. */
  news: boolean
  /** Set when a snapshot was taken: the spaces it keeps out, and why. */
  excludedSpaces: SyncExcludedSpace[] | null
}

const sameCursors = (a: FolderSyncCursors, b: FolderSyncCursors): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

/** Every page of one snapshot, restarting when its paging cursor expires. */
export const takeSnapshot = async (transport: FolderSyncTransport): Promise<FolderSyncSnapshotResponse[]> => {
  for (let attempt = 1; ; attempt += 1) {
    const pages: FolderSyncSnapshotResponse[] = []
    try {
      let cursor: string | null = null
      do {
        const page: FolderSyncSnapshotResponse = await transport.snapshot(cursor)
        pages.push(page)
        cursor = page.nextCursor
      } while (cursor !== null)
      return pages
    } catch (error) {
      const expired = syncErrorCode(error) === EXECUTOR_FOLDER_SYNC_ERROR_CODES.CURSOR_EXPIRED
      if (!expired || attempt >= SNAPSHOT_ATTEMPTS) throw error
    }
  }
}

export const snapshotInto = async (
  store: EngineStore, transport: FolderSyncTransport, takenAt: string,
): Promise<PullResult> => {
  const pages = await takeSnapshot(transport)
  await store.replaceManifest(manifestFromSnapshot(pages, takenAt), pages[0]!.cursors)
  return { news: true, excludedSpaces: pages[0]!.excludedSpaces }
}

/** True when an answer holds rows some other writer made (A12.7 echo test). */
export const hasNews = (answer: FolderSyncChangesResponse, store: EngineStore, executorId: string): boolean =>
  answer.spacesChanged || answer.cursorExpired.length > 0
  || answer.changes.some((row) => !isOwnEcho(row, row.pageId ? store.entry(row.pageId) : undefined, executorId))

/** Fold a changes answer into the stored manifest; answers whether a snapshot is now needed. */
export const foldChanges = async (store: EngineStore, answer: FolderSyncChangesResponse): Promise<boolean> => {
  const applied = applyChanges(store.index.manifest, answer)
  const cursors = { ...store.index.cursors, ...answer.cursors }
  if (applied.needsSnapshot) return true
  if (answer.changes.length > 0 || answer.pages.length > 0 || answer.gonePageIds.length > 0
    || !sameCursors(cursors, store.index.cursors)) {
    await store.replaceManifest(applied.manifest, cursors)
  }
  return false
}

export const pullRemote = async (
  store: EngineStore,
  transport: FolderSyncTransport,
  executorId: string,
  options: { snapshot: boolean; takenAt: string },
): Promise<PullResult> => {
  if (options.snapshot || store.index.manifest.snapshotAt === null) {
    return snapshotInto(store, transport, options.takenAt)
  }
  let news = false
  for (let page = 0; page < CHANGE_PAGES_PER_PULL; page += 1) {
    const answer = await transport.changes(store.index.cursors, false)
    news ||= hasNews(answer, store, executorId)
    if (await foldChanges(store, answer)) return snapshotInto(store, transport, options.takenAt)
    if (!answer.hasMore) break
  }
  return { news, excludedSpaces: null }
}

/** The manifest with this pass's own write answers and gone pages folded in. */
export const manifestWith = (
  manifest: RemoteManifest, pages: ReadonlyMap<string, RemoteManifest['pages'][number]>, gone: ReadonlySet<string>,
): RemoteManifest => ({
  ...manifest,
  pages: [...pages.values()].filter((page) => !gone.has(page.id)),
})
