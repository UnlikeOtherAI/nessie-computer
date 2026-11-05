import { FOLDER_SYNC_MERGE_MAX_BYTES, type SyncPage } from '@nessie/executor-protocol'

import { isWithin, mapTree } from './path-mapping.js'
import { localUnchanged } from './reconcile-classify.js'
import type { LocalScanItem, RemoteManifest } from './reconcile-model.js'
import type { LocalStat } from './local-fs.js'
import type { SyncEntry, SyncEntryBase, SyncEntryLocal, SyncEntryRemote } from './types.js'

/**
 * How the engine keeps index entries true after it acts (plan §2.4): an entry
 * is built from the page the server described and the file as it now is, and
 * every entry no action touched is refreshed from the manifest and the scan.
 */

export const remoteOf = (page: SyncPage): SyncEntryRemote => ({
  versionId: page.head?.versionId ?? null,
  revision: page.revision,
  contentHash: page.head?.contentHash ?? null,
  readOnly: page.readOnly,
  readOnlyReason: page.readOnlyReason,
  fidelity: page.fidelity,
})

export const localOf = (found: LocalStat, contentHash: string | null, now: number): SyncEntryLocal => ({
  fileId: found.fileId,
  size: found.size,
  mtimeMs: found.mtimeMs,
  contentHash,
  seenAt: now,
})

/** An entry for `page` at `relPath`, agreed at `base`. */
export const entryFor = (
  page: SyncPage,
  relPath: string,
  base: SyncEntryBase,
  local: SyncEntryLocal | null,
  previous: SyncEntry | undefined,
): SyncEntry => ({
  pageId: page.id,
  spaceId: page.spaceId,
  kind: page.kind,
  relPath,
  parentPageId: page.parentPageId,
  title: page.title,
  base,
  local,
  remote: remoteOf(page),
  state: 'synced',
  ...(previous?.openConflict ? { openConflict: previous.openConflict } : {}),
})

export const headBaseOf = (page: SyncPage): SyncEntryBase => ({
  versionId: page.head?.versionId ?? null,
  revision: page.revision,
  contentHash: page.head?.contentHash ?? null,
})

/** A7: whose base text is kept locally — exact Markdown and text files up to 5 MiB. */
export const keepsBaseText = (page: SyncPage): boolean => {
  if (!page.head || page.head.byteLength > FOLDER_SYNC_MERGE_MAX_BYTES) return false
  if (page.kind === 'document') return page.fidelity === 'exact'
  return page.kind === 'file'
    && (page.head.mime.startsWith('text/') || ['md', 'markdown', 'txt'].includes(page.head.extension ?? ''))
}

/** Every entry at or below `from` now lives below `to`. */
export const rewritePaths = (entries: readonly SyncEntry[], from: string, to: string): SyncEntry[] =>
  entries.filter((entry) => isWithin(entry.relPath, from)).map((entry) => ({
    ...entry,
    relPath: `${to}${entry.relPath.slice(from.length)}`,
    ...(entry.openConflict && isWithin(entry.openConflict.copyRelPath, from)
      ? { openConflict: { ...entry.openConflict, copyRelPath: `${to}${entry.openConflict.copyRelPath.slice(from.length)}` } }
      : {}),
  }))

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Refresh entries the plan left alone: the server's view of each page, the
 * file as the scan saw it, and — when the file already sits at the page's
 * mapped path and the content agrees — the page's name, parent and revision.
 * Returns only the entries that changed.
 */
export const refreshedEntries = (
  entries: readonly SyncEntry[],
  manifest: RemoteManifest,
  scanned: ReadonlyMap<string, LocalScanItem>,
  untouched: (pageId: string) => boolean,
  now: number,
): SyncEntry[] => {
  const pages = new Map(manifest.pages.map((page) => [page.id, page]))
  const mapping = mapTree(manifest.spaces, manifest.pages)
  const changed: SyncEntry[] = []
  // Two entries can name one path for a pass (one's item moved away first): the
  // item there is the one whose file id it carries, and the other must not take it.
  const othersOwn = (entry: SyncEntry, item: LocalScanItem) => item.fileId !== null
    && item.fileId !== entry.local?.fileId
    && entries.some((other) => other !== entry && other.relPath === entry.relPath
      && other.local?.fileId === item.fileId)
  for (const entry of entries) {
    if (!untouched(entry.pageId)) continue
    const page = pages.get(entry.pageId)
    let next: SyncEntry = entry
    const item = scanned.get(entry.relPath)
    if (item && (item.type === 'directory') === (entry.kind === 'folder') && item.type !== 'link'
      && !othersOwn(entry, item)) {
      const hash = entry.kind === 'folder' ? null
        : item.contentHash ?? (localUnchanged(entry.local, item) ? entry.local!.contentHash : undefined)
      if (hash !== undefined) {
        next = {
          ...next,
          local: {
            fileId: item.fileId, size: item.size, mtimeMs: item.mtimeMs, contentHash: hash,
            seenAt: entry.local?.seenAt ?? now,
          },
        }
      }
    }
    if (page) {
      next = { ...next, remote: remoteOf(page) }
      const agreed = (page.head?.versionId ?? null) === entry.base.versionId
      if (mapping.paths.get(page.id) === entry.relPath && agreed) {
        next = {
          ...next,
          title: page.title,
          parentPageId: page.parentPageId,
          spaceId: page.spaceId,
          base: { ...next.base, revision: page.revision },
        }
      }
    }
    const comparable = (value: SyncEntry) => ({ ...value, local: value.local && { ...value.local, seenAt: 0 } })
    if (!sameJson(comparable(next), comparable(entry))) changed.push(next)
  }
  return changed
}

/**
 * Space id → the directory that holds it here after a pass: its mapped
 * directory once that exists, else the one it had (a rename still to come),
 * else none. `present` is the team folder's top-level directory names.
 */
export const spaceDirsNow = (
  manifest: RemoteManifest, previous: Readonly<Record<string, string>>, present: ReadonlySet<string>,
): Record<string, string> => {
  const mapped = mapTree(manifest.spaces, manifest.pages).spaceDirs
  const next: Record<string, string> = {}
  for (const spaceId of new Set([...Object.keys(previous), ...mapped.keys()])) {
    const now = mapped.get(spaceId)
    const before = previous[spaceId]
    if (now !== undefined && present.has(now)) next[spaceId] = now
    else if (before !== undefined && present.has(before)) next[spaceId] = before
  }
  return next
}
