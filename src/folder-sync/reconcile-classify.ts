import { FOLDER_SYNC_STABLE_MS, type SyncPage } from '@nessie/executor-protocol'

import { heldByEditor } from './ignore.js'
import { baseName, isWithin, parentPath } from './path-mapping.js'
import type { LocalScan, LocalScanItem, RemoteManifest } from './reconcile-model.js'
import type { LocalChange, RemoteChange, SyncEntry, SyncEntryLocal } from './types.js'

/**
 * How each entry changed since its base, on each side (plan §2.6). Content is
 * decided by hash and `(versionId, revision)`, never by time: mtime and size
 * only let a scanner skip re-hashing a file whose (file id, size, mtime) did
 * not move (C9).
 */

/**
 * True when a stat matches the entry's last scan, so its last hash still
 * holds and the scanner need not hash it again. Anything else is hashed.
 */
export const localUnchanged = (
  previous: SyncEntryLocal | null,
  stat: { fileId: string | null; size: number; mtimeMs: number },
): boolean => previous !== null
  && previous.contentHash !== null
  && previous.fileId !== null
  && previous.fileId === stat.fileId
  && previous.size === stat.size
  && previous.mtimeMs === stat.mtimeMs

/** The scan, indexed for the reconciler. */
export class LocalIndex {
  readonly byPath = new Map<string, LocalScanItem>()
  private readonly byFileId = new Map<string, LocalScanItem[]>()
  private readonly namesByDir = new Map<string, Set<string>>()

  constructor(readonly scan: LocalScan) {
    for (const item of scan.items) {
      this.byPath.set(item.relPath, item)
      const dir = parentPath(item.relPath)
      const names = this.namesByDir.get(dir) ?? new Set<string>()
      names.add(baseName(item.relPath).toLowerCase())
      this.namesByDir.set(dir, names)
      if (item.fileId === null) continue
      const same = this.byFileId.get(item.fileId)
      if (same) same.push(item)
      else this.byFileId.set(item.fileId, [item])
    }
  }

  /** True when the scan walked this path, so its absence means it is gone. */
  inScope(relPath: string): boolean {
    return this.scan.scope === null || this.scan.scope.some((root) => isWithin(relPath, root))
  }

  withFileId(fileId: string): readonly LocalScanItem[] {
    return this.byFileId.get(fileId) ?? []
  }

  /** Still, openable, and no editor lock or temp sibling beside it (A9). */
  stable(item: LocalScanItem, now: number): boolean {
    if (!isStable(item, now)) return false
    if (item.type !== 'file') return true
    return !heldByEditor(baseName(item.relPath), this.namesByDir.get(parentPath(item.relPath)) ?? new Set())
  }
}

/** Stable: still for `FOLDER_SYNC_STABLE_MS` and openable for shared read. */
export const isStable = (item: LocalScanItem, now: number): boolean =>
  item.unopenableSinceMs === null && now - item.stableSinceMs >= FOLDER_SYNC_STABLE_MS

export type LocalState = {
  change: LocalChange
  /** The item now: at the entry's path, or where it moved. Null when deleted. */
  item: LocalScanItem | null
  /** Its hash now (folders: null). */
  contentHash: string | null
  contentChanged: boolean
  /** A changed file must be still before it is acted on; deletes need no wait. */
  stable: boolean
  /** A file the scanner did not hash and the shortcut does not cover. */
  needsHash: boolean
  /** The scan saw a link at the entry's path (C17). */
  link: boolean
}

const itemHash = (entry: SyncEntry, item: LocalScanItem): string | null => (
  item.contentHash ?? (localUnchanged(entry.local, item) ? entry.local!.contentHash : null)
)

const matchesType = (entry: SyncEntry, item: LocalScanItem): boolean =>
  (entry.kind === 'folder') === (item.type === 'directory') && item.type !== 'link'

/**
 * The untracked item an entry moved to: the one scan item with the entry's
 * file id, of its type, whose content is the entry's (rename detection is file
 * id *and* hash; a recycled inode with other bytes is a delete and a create).
 */
const movedItem = (
  entry: SyncEntry,
  local: LocalIndex,
  isUntracked: (item: LocalScanItem) => boolean,
): LocalScanItem | null => {
  const fileId = entry.local?.fileId ?? null
  if (fileId === null) return null
  const candidates = local.withFileId(fileId).filter((item) => (
    isUntracked(item) && matchesType(entry, item)
    && (entry.kind === 'folder' || [entry.local?.contentHash, entry.base.contentHash].includes(itemHash(entry, item)))
  ))
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * L for one entry. An entry outside the scan's scope is judged from its last
 * scan; one with no last scan outside the scope is unknown (null) and gets no
 * action.
 */
export const classifyLocal = (
  entry: SyncEntry,
  local: LocalIndex,
  now: number,
  isUntracked: (item: LocalScanItem) => boolean,
  /** True when another entry at the same path is this item's (its file id): this entry's file left. */
  heldByOther: (entry: SyncEntry, item: LocalScanItem) => boolean = () => false,
  /** Where the entry is now if it only went along with an enclosing folder that moved. */
  carriedTo: string | null = null,
): LocalState | null => {
  if (!local.inScope(entry.relPath)) {
    if (entry.local === null) return null
    const changed = entry.kind !== 'folder' && entry.local.contentHash !== entry.base.contentHash
    return {
      change: changed ? 'modified' : 'same',
      item: null,
      contentHash: entry.local.contentHash,
      contentChanged: changed,
      stable: !changed,
      needsHash: false,
      link: false,
    }
  }
  const atPath = local.byPath.get(entry.relPath)
  if (atPath?.type === 'link') {
    return { change: 'same', item: null, contentHash: null, contentChanged: false, stable: false, needsHash: false, link: true }
  }
  // An item carried along by its folder's move keeps its identity by file id
  // alone: edited before the move, its bytes are neither its last scan's nor its base's.
  const carried = carriedTo === null ? undefined : local.byPath.get(carriedTo)
  const present = atPath && matchesType(entry, atPath) && !heldByOther(entry, atPath)
    ? atPath
    : carried && matchesType(entry, carried) && isUntracked(carried)
      && carried.fileId !== null && carried.fileId === entry.local?.fileId
      ? carried
      : movedItem(entry, local, isUntracked)
  if (!present) {
    return { change: 'deleted', item: null, contentHash: null, contentChanged: false, stable: true, needsHash: false, link: false }
  }
  const moved = present.relPath !== entry.relPath
  const hash = entry.kind === 'folder' ? null : itemHash(entry, present)
  // A file the scanner did not hash is treated as changed and unsettled:
  // nothing may overwrite or remove bytes nobody has looked at.
  const needsHash = entry.kind !== 'folder' && hash === null
  const contentChanged = entry.kind !== 'folder' && (needsHash || hash !== entry.base.contentHash)
  const change: LocalChange = moved ? 'moved' : contentChanged ? 'modified' : 'same'
  return {
    change,
    item: present,
    contentHash: hash,
    contentChanged,
    stable: !needsHash && local.stable(present, now),
    needsHash,
    link: false,
  }
}

export type RemoteState = {
  change: RemoteChange
  page: SyncPage | null
  /** The head is a different version from the base. */
  contentChanged: boolean
  /** Parent, space, title or mapped name differ from the base. */
  moved: boolean
  /** Same version, but the server's rendering of it hashes differently (convergence). */
  renderingChanged: boolean
  readOnly: boolean
}

/** R for one entry, against the manifest and the page's mapped path. */
export const classifyRemote = (
  entry: SyncEntry,
  page: SyncPage | null,
  desiredPath: string | null,
  manifest: RemoteManifest,
): RemoteState => {
  if (page === null) {
    const spaceMirrored = manifest.spaces.some((space) => space.id === entry.spaceId)
      && !manifest.excludedSpaceIds.includes(entry.spaceId)
    return {
      change: spaceMirrored ? 'deleted' : 'access_lost',
      page: null,
      contentChanged: false,
      moved: false,
      renderingChanged: false,
      readOnly: false,
    }
  }
  const headVersion = page.head?.versionId ?? null
  const contentChanged = page.kind !== 'folder' && headVersion !== entry.base.versionId
  const moved = page.parentPageId !== entry.parentPageId
    || page.spaceId !== entry.spaceId
    || page.title !== entry.title
    || (desiredPath !== null && desiredPath !== entry.relPath)
  const renderingChanged = !contentChanged && page.head !== null && page.head.contentHash !== entry.base.contentHash
  const change: RemoteChange = contentChanged
    ? 'modified'
    : moved
      ? 'moved'
      : page.readOnly && entry.remote?.readOnly !== true ? 'readonly_now' : 'same'
  return { change, page, contentChanged, moved, renderingChanged, readOnly: page.readOnly }
}
