import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { FOLDER_SYNC_STABLE_MS } from '@nessie/executor-protocol'

import { isSyncMarkerName } from './config.js'
import { isIgnoredName } from './ignore.js'
import { FolderSyncFileBusyError, confinedPath, fsPath, hashFile, lstatOrNull, type LocalStat } from './local-fs.js'
import { localUnchanged } from './reconcile-classify.js'
import type { LocalScanItem } from './reconcile-model.js'
import type { SyncEntry } from './types.js'

/**
 * The walk of the team folder that feeds the reconciler (plan §2.7). `lstat`
 * every item and never follow a link; report hidden and ignored names as items
 * (A9 lock detection reads siblings) without hashing them or descending into
 * them; hash a file only once it has been still for `FOLDER_SYNC_STABLE_MS`
 * and only when its stat moved since the entry's last scan.
 *
 * The scanner remembers, per path, the stat it last saw and when that stat
 * first appeared, so stability survives between passes; a restart simply
 * waits two seconds once.
 */

type Seen = {
  fileId: string
  size: number
  mtimeMs: number
  stableSinceMs: number
  contentHash: string | null
  unopenableSinceMs: number | null
}

export type ScanResult = {
  items: LocalScanItem[]
  /** Links found (C17): reported, never followed. */
  links: string[]
}

const sameStat = (seen: Seen | undefined, found: LocalStat): seen is Seen =>
  seen !== undefined && seen.fileId === found.fileId && seen.size === found.size && seen.mtimeMs === found.mtimeMs

export class LocalScanner {
  private readonly seen = new Map<string, Seen>()

  /**
   * Walk `teamDir`, or only the subtrees in `scope` (team-relative). Entries
   * give the hash shortcut: a file whose (file id, size, mtime) equals its
   * entry's last scan keeps that hash unread.
   */
  async scan(
    teamDir: string,
    entries: readonly SyncEntry[],
    scope: readonly string[] | null,
    now: number,
  ): Promise<ScanResult> {
    const byPath = new Map(entries.map((entry) => [entry.relPath, entry]))
    const items: LocalScanItem[] = []
    const links: string[] = []
    const visit = async (relPath: string, found: LocalStat, ignored: boolean): Promise<void> => {
      if (found.type === 'other') return
      if (found.type === 'link') {
        links.push(relPath)
        items.push(this.item(relPath, 'link', found, null, now, null))
        return
      }
      if (found.type === 'directory') {
        const names = ignored ? [] : await namesIn(relPath)
        // Another sync's folder (another team on this computer) holds its marker:
        // it is that team's mirror, never this team's content to send.
        if (names?.some(isSyncMarkerName)) return
        items.push(this.item(relPath, 'directory', found, null, now, null))
        if (names) await walk(relPath, names)
        return
      }
      items.push(await this.file(teamDir, relPath, found, byPath.get(relPath) ?? null, ignored, now))
    }
    const namesIn = (dirRel: string): Promise<string[] | null> =>
      namesOrGone(dirRel === '' ? teamDir : confinedPath(teamDir, dirRel))
    const walk = async (dirRel: string, listed?: string[]): Promise<void> => {
      const names = listed ?? await namesIn(dirRel)
      if (!names) return
      for (const name of [...names].sort()) {
        const relPath = dirRel === '' ? name : `${dirRel}/${name}`
        const found = await lstatOrNull(join(teamDir, ...relPath.split('/')))
        if (found) await visit(relPath, found, isIgnoredName(name))
      }
    }
    const roots = scope === null ? [''] : collapse(scope)
    for (const root of roots) {
      if (root === '') {
        await walk('')
        continue
      }
      const found = await lstatOrNull(confinedPath(teamDir, root))
      if (found) await visit(root, found, root.split('/').some(isIgnoredName))
    }
    const walked = new Set(items.map((item) => item.relPath))
    for (const path of this.seen.keys()) {
      if (!walked.has(path) && (roots.includes('') || roots.some((r) => path === r || path.startsWith(`${r}/`)))) {
        this.seen.delete(path)
      }
    }
    return { items, links }
  }

  /**
   * Scope roots spelled as they are on disk. A hint may name a path in a case
   * the disk no longer uses (a folder renamed in case only); walked as spelled,
   * its items would not match their entries and would look new.
   */
  async canonicalScope(teamDir: string, scope: readonly string[]): Promise<string[]> {
    const canonical: string[] = []
    for (const root of scope) {
      let resolved = ''
      for (const segment of root === '' ? [] : root.split('/')) {
        const names = await namesOrGone(resolved === '' ? teamDir : confinedPath(teamDir, resolved)) ?? []
        const found = names.includes(segment) ? segment
          : names.find((name) => name.toLowerCase() === segment.toLowerCase()) ?? segment
        resolved = resolved === '' ? found : `${resolved}/${found}`
      }
      canonical.push(resolved)
    }
    return canonical
  }

  /** Forget what is known about a path we just wrote, so its next stat is judged afresh. */
  written(relPath: string, found: LocalStat, contentHash: string | null): void {
    this.seen.set(relPath, {
      fileId: found.fileId, size: found.size, mtimeMs: found.mtimeMs,
      stableSinceMs: 0, contentHash, unopenableSinceMs: null,
    })
  }

  private item(
    relPath: string, type: LocalScanItem['type'], found: LocalStat, contentHash: string | null, now: number,
    unopenableSinceMs: number | null,
  ): LocalScanItem {
    const previous = this.seen.get(relPath)
    const stableSinceMs = sameStat(previous, found) ? previous.stableSinceMs : now
    this.seen.set(relPath, {
      fileId: found.fileId, size: found.size, mtimeMs: found.mtimeMs, stableSinceMs, contentHash, unopenableSinceMs,
    })
    return {
      relPath, type, fileId: found.fileId, size: found.size, mtimeMs: found.mtimeMs,
      contentHash, stableSinceMs, unopenableSinceMs,
    }
  }

  private async file(
    teamDir: string, relPath: string, found: LocalStat, entry: SyncEntry | null, ignored: boolean, now: number,
  ): Promise<LocalScanItem> {
    const previous = this.seen.get(relPath)
    const unchangedEntry = entry !== null && localUnchanged(entry.local, found)
    // A stat the entry already holds is still since the entry saw it.
    const stableSinceMs = sameStat(previous, found) ? previous.stableSinceMs : unchangedEntry ? 0 : now
    if (ignored || unchangedEntry) return this.record(relPath, found, null, stableSinceMs, null)
    if (sameStat(previous, found) && previous.contentHash !== null) {
      return this.record(relPath, found, previous.contentHash, stableSinceMs, null)
    }
    if (now - stableSinceMs < FOLDER_SYNC_STABLE_MS) return this.record(relPath, found, null, stableSinceMs, null)
    try {
      const contentHash = await hashFile(confinedPath(teamDir, relPath))
      // The hash only holds if the file did not move while it was read.
      const after = await lstatOrNull(confinedPath(teamDir, relPath))
      if (after === null || !sameStat({ ...found, stableSinceMs, contentHash, unopenableSinceMs: null }, after)) {
        return this.record(relPath, after ?? found, null, now, null)
      }
      return this.record(relPath, found, contentHash, stableSinceMs, null)
    } catch (error) {
      if (!(error instanceof FolderSyncFileBusyError)) throw error
      return this.record(relPath, found, null, stableSinceMs, previous?.unopenableSinceMs ?? now)
    }
  }

  private record(
    relPath: string, found: LocalStat, contentHash: string | null, stableSinceMs: number,
    unopenableSinceMs: number | null,
  ): LocalScanItem {
    this.seen.set(relPath, {
      fileId: found.fileId, size: found.size, mtimeMs: found.mtimeMs, stableSinceMs, contentHash, unopenableSinceMs,
    })
    return {
      relPath, type: 'file', fileId: found.fileId, size: found.size, mtimeMs: found.mtimeMs,
      contentHash, stableSinceMs, unopenableSinceMs,
    }
  }
}

/** Missing folders are deletions; an unreadable folder is never an empty one. */
const namesOrGone = async (absolute: string): Promise<string[] | null> => {
  try {
    return await readdir(fsPath(absolute))
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** Scope roots without any that another contains. */
const collapse = (scope: readonly string[]): string[] => {
  const sorted = [...new Set(scope)].sort((a, b) => a.length - b.length)
  const kept: string[] = []
  for (const root of sorted) {
    if (!kept.some((k) => k === '' || root === k || root.startsWith(`${k}/`))) kept.push(root)
  }
  return kept
}
