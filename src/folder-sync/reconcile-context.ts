import { createHash } from 'node:crypto'

import { canonicalFolderSyncDescendantRevisions, type FolderSyncReadOnlyReason, type SyncPage } from '@nessie/executor-protocol'

import { LocalIndex, type LocalState } from './reconcile-classify.js'
import {
  PHASE,
  PlanBuilder,
  conflictedCopyName,
  formatStamp,
  freePath,
  pageKeyFor,
  type LocalScanItem,
  type Phase,
  type ReconcileInput,
} from './reconcile-model.js'
import { firstSegment, mapTree, nameKey, parentPath, type TreeMapping } from './path-mapping.js'
import type {
  ExpectedLocal,
  FolderSyncConflictReason,
  RemoteParent,
  SyncEntry,
  SyncEntryBase,
} from './types.js'

/**
 * What every planning step shares: the mapping of the server tree, the scan,
 * the plan, and where things will be once the plan's own moves have run.
 *
 * Paths come in two flavours. A *raw* path is where the scan saw an item. A
 * *current* path is where it will be after the local moves planned so far
 * (space renames, remote renames applied here, items moved aside), which are
 * prefix rewrites — moving a folder moves everything in it. The *wanted* path
 * of a page is its mapped path, rewritten by the server moves planned so far
 * (a local folder move about to be sent), so a page inside it is already where
 * the server will put it.
 */

export type ResolvedParent = { spaceId: string; parent: RemoteParent }

type Rewrite = readonly [from: string, to: string]

const rewritePath = (path: string, from: string, to: string): string => {
  if (nameKey(path) === nameKey(from)) return to
  return nameKey(path).startsWith(`${nameKey(from)}/`) ? `${to}${path.slice(from.length)}` : path
}

export type ReadOnlyConflictReason = Extract<
  FolderSyncConflictReason,
  'read_only_document_formatting' | 'read_only_spreadsheet' | 'read_only_published' | 'read_only_no_write_access'
>

export const readOnlyReasonCode = (reason: FolderSyncReadOnlyReason | null): ReadOnlyConflictReason => {
  if (reason === 'document_formatting') return 'read_only_document_formatting'
  if (reason === 'spreadsheet') return 'read_only_spreadsheet'
  if (reason === 'published') return 'read_only_published'
  return 'read_only_no_write_access'
}

export class ReconcileContext {
  readonly plan: PlanBuilder
  readonly mapping: TreeMapping
  readonly pages: ReadonlyMap<string, SyncPage>
  readonly local: LocalIndex
  readonly stamp: string
  /** Untracked scan items by raw path; `consumed` once a step accounted for one. */
  readonly untracked = new Map<string, { item: LocalScanItem; consumed: boolean }>()
  private readonly localRewrites: Rewrite[] = []
  private readonly remoteRewrites: Rewrite[] = []
  private readonly movingCycleFolders = new Set<string>()
  /** Raw folder location → the page that holds it. */
  private readonly folders = new Map<string, ResolvedParent>()
  private readonly spaceByDir = new Map<string, string>()
  /** Every path some item occupies, or will once the plan has run. */
  readonly occupied = new Set<string>()

  constructor(readonly input: ReconcileInput) {
    this.plan = new PlanBuilder(input)
    this.mapping = mapTree(input.remote.spaces, input.remote.pages)
    this.pages = new Map(input.remote.pages.map((page) => [page.id, page]))
    this.local = new LocalIndex(input.local)
    this.stamp = formatStamp(input.now, input.utcOffsetMinutes)
    for (const [spaceId, dir] of this.mapping.spaceDirs) this.spaceByDir.set(nameKey(dir), spaceId)
    for (const item of input.local.items) this.occupied.add(nameKey(item.relPath))
    for (const path of this.mapping.paths.values()) this.occupied.add(nameKey(path))
    for (const entry of input.entries) {
      this.occupied.add(nameKey(entry.relPath))
      if (entry.openConflict) this.occupied.add(nameKey(entry.openConflict.copyRelPath))
    }
  }

  /** Live pages below `pageId` in the manifest: an archive's subtree guard (A12.6). */
  archivePrecondition(pageId: string): { descendantCount: number; descendantHash: string } {
    const descendants: SyncPage[] = []
    const pending = [pageId]
    while (pending.length > 0) {
      const id = pending.pop()!
      for (const page of this.childrenOf(id)) {
        descendants.push(page)
        pending.push(page.id)
      }
    }
    return {
      descendantCount: descendants.length,
      descendantHash: `sha256:${createHash('sha256').update(canonicalFolderSyncDescendantRevisions(descendants)).digest('hex')}`,
    }
  }

  private children: Map<string, SyncPage[]> | null = null

  private childrenOf(pageId: string): readonly SyncPage[] {
    if (!this.children) {
      this.children = new Map()
      for (const page of this.pages.values()) {
        if (page.parentPageId === null) continue
        const list = this.children.get(page.parentPageId) ?? []
        list.push(page)
        this.children.set(page.parentPageId, list)
      }
    }
    return this.children.get(pageId) ?? []
  }

  // ── Paths ────────────────────────────────────────────────────────────────

  current(rawPath: string): string {
    return this.localRewrites.reduce((path, [from, to]) => rewritePath(path, from, to), rawPath)
  }

  raw(currentPath: string): string {
    return this.localRewrites.reduceRight((path, [from, to]) => rewritePath(path, to, from), currentPath)
  }

  wanted(mappedPath: string): string {
    return this.remoteRewrites.reduce((path, [from, to]) => rewritePath(path, from, to), mappedPath)
  }

  /** A local move is planned: everything at or below `from` will be at `to`. */
  movedLocally(from: string, to: string): void {
    this.localRewrites.push([from, to])
    this.occupied.add(nameKey(to))
  }

  /** Vacating a child waits until a folder's physical rename has carried it there. */
  awaitingFolderMove(path: string): boolean {
    const insideSpace = (value: string) => value.slice(value.indexOf('/'))
    return insideSpace(this.raw(path)) !== insideSpace(path)
  }

  /** A rename cycle moves its roots first; their children are planned from the next scan. */
  deferCycleFolder(path: string): void { this.movingCycleFolders.add(nameKey(path)) }

  belowMovingCycle(path: string): boolean {
    return [...this.movingCycleFolders].some((root) => nameKey(path).startsWith(`${root}/`))
  }

  /** A server move is planned: the page mapped at `from` (and its subtree) will map to `to`. */
  movedRemotely(from: string, to: string): void {
    this.remoteRewrites.push([from, to])
  }

  /** A free sibling name for `path`, reserved for this plan. */
  reserve(path: string): string {
    const free = freePath(path, this.occupied)
    this.occupied.add(nameKey(free))
    return free
  }

  // ── Space and folder resolution ──────────────────────────────────────────

  /** Remember a space's directory as the entries knew it, before a rename. */
  knowSpaceDir(dir: string, spaceId: string): void {
    if (!this.spaceByDir.has(nameKey(dir))) this.spaceByDir.set(nameKey(dir), spaceId)
  }

  spaceOfDir(currentDir: string): string | null {
    return this.spaceByDir.get(nameKey(currentDir)) ?? this.spaceByDir.get(nameKey(this.raw(currentDir))) ?? null
  }

  writableSpace(spaceId: string): boolean {
    return this.input.remote.spaces.some((space) => space.id === spaceId && space.writable)
  }

  /** The page now at a raw folder location (a tracked folder, an adopted or recreated one). */
  registerFolder(rawPath: string, resolved: ResolvedParent): void {
    this.folders.set(nameKey(rawPath), resolved)
  }

  /**
   * Which page a local directory stands for, as a parent: a space root, a
   * tracked folder, a folder this plan recreates or adopts, or an untracked
   * directory this plan creates (named by its pending key). Null when the
   * directory is none of these (the team folder itself, or a place that
   * cannot hold pages).
   */
  parentFor(currentDir: string): ResolvedParent | null {
    if (currentDir === '') return null
    if (!currentDir.includes('/')) {
      const spaceId = this.spaceOfDir(currentDir)
      return spaceId === null ? null : { spaceId, parent: { type: 'existing', pageId: null } }
    }
    const known = this.folders.get(nameKey(this.raw(currentDir)))
    if (known) return known
    const spaceId = this.spaceOfDir(firstSegment(currentDir))
    const candidate = this.untrackedAt(currentDir)
    if (spaceId === null || candidate?.type !== 'directory') return null
    return { spaceId, parent: { type: 'pending', pageKey: pageKeyFor(this.input.passId, currentDir) } }
  }

  /**
   * True when `page`'s parent folder is (or this plan puts it) where `path`
   * says: a space root, the folder this plan registered there, or the
   * parent's own entry at that place.
   */
  parentPlaced(page: SyncPage, path: string): boolean {
    if (page.parentPageId === null) return true
    const dir = parentPath(path)
    const known = this.folders.get(nameKey(this.raw(dir)))
    if (known) return known.parent.type === 'existing' && known.parent.pageId === page.parentPageId
    const entry = this.input.entries.find((candidate) => candidate.pageId === page.parentPageId)
    return entry !== undefined && nameKey(this.current(entry.relPath)) === nameKey(dir)
  }

  // ── Untracked items ──────────────────────────────────────────────────────

  /** The unclaimed untracked item that will be at `currentPath`, if any. */
  untrackedAt(currentPath: string): LocalScanItem | null {
    const found = this.untracked.get(this.raw(currentPath))
    if (!found || found.consumed || found.item.type === 'link') return null
    return nameKey(this.current(found.item.relPath)) === nameKey(currentPath) ? found.item : null
  }

  /** An item an entry no longer accounts for becomes an untracked item. */
  release(item: LocalScanItem): void {
    this.untracked.set(item.relPath, { item, consumed: false })
  }

  consume(item: LocalScanItem): void {
    const found = this.untracked.get(item.relPath)
    if (found) found.consumed = true
  }

  stable(item: LocalScanItem): boolean {
    return this.local.stable(item, this.input.now) && (item.type !== 'file' || item.contentHash !== null)
  }

  // ── Action pieces ────────────────────────────────────────────────────────

  expectItem(item: LocalScanItem, contentHash: string | null = item.contentHash): ExpectedLocal {
    return { fileId: item.fileId, contentHash }
  }

  expectEntryLocal(entry: SyncEntry): ExpectedLocal | null {
    return entry.local === null ? null : { fileId: entry.local.fileId, contentHash: entry.local.contentHash }
  }

  /** What an action on the entry expects to find: the item as scanned, else the entry's last scan. */
  expectNow(L: LocalState, entry: SyncEntry): ExpectedLocal | null {
    return L.item ? this.expectItem(L.item, L.contentHash) : this.expectEntryLocal(entry)
  }

  /** Over the server's limit (C15): the entry rests in error and the row says so. */
  tooLarge(entry: SyncEntry, L: LocalState, cur: string): boolean {
    if (!L.item || L.item.size <= this.input.maxUploadBytes) return false
    this.plan.setState(entry, 'error', { code: 'too_large', message: 'Too large to upload.' })
    this.plan.record('too_large', { pageId: entry.pageId, relPath: cur }, L.contentHash ?? '')
    return true
  }

  /** The base a write is checked against when the server's content is still the base's. */
  rebased(entry: SyncEntry, page: SyncPage): SyncEntryBase {
    return { versionId: entry.base.versionId, revision: page.revision, contentHash: entry.base.contentHash }
  }

  headBase(page: SyncPage): SyncEntryBase {
    return {
      versionId: page.head?.versionId ?? null,
      revision: page.revision,
      contentHash: page.head?.contentHash ?? null,
    }
  }

  /** Put a page's content (or its folder) at `path`, which must be free when it runs. */
  materialize(page: SyncPage, path: string, base: SyncEntryBase | null, phase: Phase = PHASE.materialize): void {
    if (page.kind === 'folder') {
      this.plan.add(phase, { type: 'mkdir', pageId: page.id, relPath: path }, path)
      return
    }
    if (!page.head) return
    this.plan.add(phase, {
      type: 'download',
      pageId: page.id,
      versionId: page.head.versionId,
      relPath: path,
      contentHash: page.head.contentHash,
      byteLength: page.head.byteLength,
      readOnly: page.readOnly,
      expect: { base, local: null },
    }, path)
  }

  /**
   * Make `path` free for a page before it lands there (C6, C7). An untracked
   * item already there is: adopted when it is the same thing (a folder, or a
   * file with the head's exact bytes); kept as a conflicted copy when it is a
   * different file; moved aside to ` (2)` when it is the other type. Returns
   * `adopted`, `cleared` (nothing there, or moved away), or `wait` (the item
   * is still changing). A page whose own item is moving to `path` passes
   * `adopt: false`: the item in its way is a new one and is moved aside.
   */
  claim(page: SyncPage, path: string, adopt = true): 'adopted' | 'cleared' | 'wait' {
    // Another entry still at `path` keeps it until it is planned away (moved,
    // trashed, recreated elsewhere): a download there would only fail. A page
    // moving its own item here (`adopt: false`) parks a holder instead.
    const named = adopt && this.input.entries.some((entry) => entry.pageId !== page.id
      && nameKey(this.current(entry.relPath)) === nameKey(path))
    if (named) return 'wait'
    // A tracked item that stays at `path` (a person moved it there) is not this page's to replace.
    const own = this.input.entries.find((entry) => entry.pageId === page.id)
    const at = this.local.byPath.get(this.raw(path))
    if (adopt && at && !this.untrackedAt(path) && nameKey(this.current(at.relPath)) === nameKey(path)
      && at.relPath !== own?.relPath && (at.fileId === null || at.fileId !== own?.local?.fileId)) return 'wait'
    const occupant = this.untrackedAt(path)
    if (!occupant) return 'cleared'
    if (!this.stable(occupant)) return 'wait'
    const sameType = (page.kind === 'folder') === (occupant.type === 'directory')
    if (adopt && sameType && (page.kind === 'folder' || occupant.contentHash === page.head?.contentHash)) {
      this.consume(occupant)
      this.plan.add(PHASE.materialize, { type: 'adopt', pageId: page.id, relPath: path, base: this.headBase(page) }, path)
      if (page.kind === 'folder') {
        this.registerFolder(occupant.relPath, { spaceId: page.spaceId, parent: { type: 'existing', pageId: page.id } })
      }
      return 'adopted'
    }
    // An item a folder's local move is still carrying here (space renames run
    // first): moving it aside now would run before it arrives. Next pass, as
    // the C6 it is — not a new page of its own meanwhile.
    const inSpace = (relPath: string) => relPath.slice(relPath.indexOf('/'))
    if (inSpace(occupant.relPath) !== inSpace(path)) {
      this.consume(occupant)
      return 'wait'
    }
    const aside = this.reserve(sameType && page.kind !== 'folder' ? this.conflictedCopyPath(path) : path)
    if (sameType && page.kind !== 'folder') {
      this.plan.add(PHASE.vacate, {
        type: 'conflictCopy',
        pageId: null,
        relPath: path,
        copyRelPath: aside,
        reason: 'created_on_both_sides',
        expect: { base: null, local: this.expectItem(occupant) },
      }, path)
    } else {
      this.plan.add(PHASE.vacate, {
        type: 'moveLocal',
        pageId: null,
        fromRelPath: path,
        toRelPath: aside,
        expect: { base: null, local: this.expectItem(occupant) },
      }, path)
      if (!sameType) this.plan.record('type_changed', { pageId: page.id, relPath: path }, aside)
    }
    this.movedLocally(path, aside)
    return 'cleared'
  }

  /**
   * A live page no entry tracks whose mapped path is `path`: another computer
   * recreated something deleted in Nessie there first (C2, C5b on two
   * computers). Recreating it again would give one path to two pages.
   */
  twinAt(path: string, skip: readonly string[]): SyncPage | null {
    const tracked = new Set(this.input.entries.map((entry) => entry.pageId))
    for (const [pageId, mapped] of this.mapping.paths) {
      if (tracked.has(pageId) || skip.includes(pageId)) continue
      const page = this.pages.get(pageId)
      if (page && nameKey(this.wanted(mapped)) === nameKey(path)) return page
    }
    return null
  }

  conflictedCopyPath(path: string): string {
    const slash = path.lastIndexOf('/')
    const dir = slash < 0 ? '' : path.slice(0, slash + 1)
    return `${dir}${conflictedCopyName(path.slice(slash + 1), this.input.computerLabel, this.stamp)}`
  }
}
