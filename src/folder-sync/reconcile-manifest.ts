import type {
  FolderSyncChangesResponse,
  FolderSyncSnapshotResponse,
  JournalRow,
  SyncPage,
} from '@nessie/executor-protocol'

import type { RemoteManifest } from './reconcile-model.js'
import type { SyncEntry } from './types.js'

/**
 * The server's truth the reconciler plans against, assembled from a paged
 * snapshot and the change pages after it. Pure: the engine persists the
 * result beside the index.
 */

export const EMPTY_MANIFEST: RemoteManifest = { snapshotAt: null, spaces: [], excludedSpaceIds: [], pages: [] }

/** Every page of one snapshot, in order, as one manifest taken at `takenAt`. */
export const manifestFromSnapshot = (
  pages: readonly FolderSyncSnapshotResponse[],
  takenAt: string,
): RemoteManifest => {
  const first = pages[0]
  if (!first) throw new Error('A snapshot has at least one page.')
  return {
    snapshotAt: takenAt,
    spaces: first.spaces,
    excludedSpaceIds: first.excludedSpaces.map((space) => space.spaceId),
    pages: pages.flatMap((page) => page.pages),
  }
}

export type AppliedChanges = {
  manifest: RemoteManifest
  /**
   * The changes cannot be applied from what they carry: a space changed, a
   * cursor expired, a subtree came back (`page_restored`) or a folder came into
   * reach whose contents the answer does not list. Take a snapshot.
   */
  needsSnapshot: boolean
}

const descendantsOf = (pages: ReadonlyMap<string, SyncPage>, roots: ReadonlySet<string>): Set<string> => {
  const children = new Map<string, string[]>()
  for (const page of pages.values()) {
    if (page.parentPageId === null) continue
    const list = children.get(page.parentPageId)
    if (list) list.push(page.id)
    else children.set(page.parentPageId, [page.id])
  }
  const found = new Set<string>()
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      visit(child)
    }
  }
  for (const root of roots) visit(root)
  return found
}

/**
 * Apply one changes answer. Named pages replace their entries; gone pages
 * leave with their subtree (an archive names only its root); a page that
 * changed space takes its subtree with it, since a cross-space move is one
 * row in the destination space.
 */
export const applyChanges = (manifest: RemoteManifest, answer: FolderSyncChangesResponse): AppliedChanges => {
  const pages = new Map(manifest.pages.map((page) => [page.id, page]))
  let needsSnapshot = answer.spacesChanged || answer.cursorExpired.length > 0
    || answer.changes.some((row: JournalRow) => row.kind === 'page_restored')

  const gone = new Set(answer.gonePageIds)
  for (const id of descendantsOf(pages, gone)) gone.add(id)
  for (const id of gone) pages.delete(id)

  for (const page of answer.pages) {
    const previous = pages.get(page.id)
    if (!previous && page.kind === 'folder') needsSnapshot = true
    pages.set(page.id, page)
    if (previous && previous.spaceId !== page.spaceId) {
      for (const id of descendantsOf(pages, new Set([page.id]))) {
        const child = pages.get(id)!
        pages.set(id, { ...child, spaceId: page.spaceId })
      }
    }
  }
  return { manifest: { ...manifest, pages: [...pages.values()] }, needsSnapshot }
}

/**
 * Echo suppression (plan §2.6), journal side: a row this computer's own write
 * made, whose result the entry's base already holds. Content-based: the
 * version (or, for moves, the revision) is compared, never a time.
 */
export const isOwnEcho = (row: JournalRow, entry: SyncEntry | undefined, executorId: string): boolean => {
  if (row.actorExecutorId !== executorId || !entry || row.pageId !== entry.pageId) return false
  if (row.versionId !== null) return row.versionId === entry.base.versionId
  return row.revision !== null && row.revision <= entry.base.revision
}
