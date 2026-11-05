import { FOLDER_SYNC_TIMING, type SyncPage } from '@nessie/executor-protocol'

import { PHASE, operationKeyFor, pageKeyFor, quarantineCopyName, type LocalScanItem } from './reconcile-model.js'
import type { LocalState, RemoteState } from './reconcile-classify.js'
import { SYNC_COMMENT, openConflictOf, planBothChanged, planDivergeIntoCopy } from './reconcile-conflicts.js'
import { readOnlyReasonCode, type ReconcileContext } from './reconcile-context.js'
import { baseName, isWithin, nameKey, parentPath, titleForLocalName } from './path-mapping.js'
import type { ReconcileAction, RemoteParent, SyncEntry } from './types.js'
import { LocalMovePlanner } from './reconcile-local-moves.js'

/**
 * One entry's row of the conflict matrix (plan §3): its local change L and
 * remote change R decide its actions. `reconciler.ts` classifies every entry
 * and precomputes the cross-entry decisions (which deleted folders come back,
 * which spaces were lost) before this runs top-down.
 */

export type EntryPlanState = {
  entry: SyncEntry
  L: LocalState | null
  R: RemoteState
  /** The page's mapped path; null when the page is gone or unmappable. */
  mapped: string | null
}

/** Cross-entry decisions, made before any entry is planned. */
export type EntryDecisions = {
  /** Locally deleted entries that come back (R4, C3, C5a, R1). */
  restore: ReadonlySet<string>
  /** Folders deleted in Nessie that are recreated around kept content (C5b). */
  recreate: ReadonlySet<string>
  /** Recreated folders whose only kept content is new local items: the row goes on the folder. */
  recreateRowOnFolder: ReadonlySet<string>
  /** Folders deleted in Nessie that cannot go to the trash whole (something inside stays). */
  keepWhole: ReadonlySet<string>
  /** Folders deleted locally whose whole subtree is archived by one archive. */
  archivedFolders: string[]
  /** Folders deleted in Nessie whose whole directory goes to the trash. */
  trashedFolders: string[]
  /** Archives the brake decides on. */
  archives: ArchiveCandidate[]
  /**
   * Untracked live folders a recreated folder adopted instead of making a
   * twin: another computer recreated it first, at the same path.
   */
  adoptedTwins: string[]
}

export type ArchiveCandidate = {
  action: Extract<ReconcileAction, { type: 'archiveRemote' }>
  /** Entries this archive removes (a folder archives its subtree). */
  affected: number
  spaceId: string
}

const isAncestorIn = (relPath: string, folders: readonly string[]): boolean =>
  folders.some((folder) => relPath !== folder && isWithin(relPath, folder))

export class EntryPlanner {
  private readonly moves: LocalMovePlanner
  constructor(
    private readonly ctx: ReconcileContext,
    private readonly decisions: EntryDecisions,
    /** Entries this pass settled with nothing to do. */
    private readonly settled: Set<string>,
    /** Page id → the item each entry stands for on disk now (classified L). */
    items: ReadonlyMap<string, LocalScanItem | null> = new Map(),
  ) { this.moves = new LocalMovePlanner(ctx, decisions, items) }

  private get plan() { return this.ctx.plan }

  planEntry(state: EntryPlanState): void {
    const { entry, L, R } = state
    if (L === null) return
    if (this.ctx.belowMovingCycle(L.item?.relPath ?? entry.relPath)) return
    if (entry.detail?.retryAt !== undefined && this.ctx.input.now < entry.detail.retryAt) return
    if (L.link) {
      this.plan.setState(entry, 'error', { code: 'link_not_synced', message: 'A link replaced this file.' })
      this.plan.record('link_not_synced', { pageId: entry.pageId, relPath: entry.relPath }, 'link')
      return
    }
    if (R.page && R.page.kind !== 'folder' && R.page.head === null) return
    if (R.page && state.mapped === null) {
      this.plan.setState(entry, 'error', { code: 'name_not_supported', message: 'This page has no path on disk.' })
      this.plan.record('name_not_supported', { pageId: entry.pageId, relPath: entry.relPath }, R.page.title)
      return
    }
    const cur = this.ctx.current(L.item?.relPath ?? entry.relPath)
    const changedHere = L.change === 'modified' || L.change === 'moved'
    if (changedHere && (!L.stable || L.needsHash)) {
      this.waiting(entry, L, cur)
      return
    }
    if (R.change === 'access_lost') return
    if (R.change === 'deleted') this.remoteDeleted(state, cur)
    else if (L.change === 'deleted') this.localDeleted(state)
    else this.present(state, cur)
  }

  private waiting(entry: SyncEntry, L: LocalState, cur: string): void {
    const since = L.item?.unopenableSinceMs ?? null
    if (since !== null && this.ctx.input.now - since >= FOLDER_SYNC_TIMING.waitingReportedAfterMs) {
      this.plan.record('file_in_use', { pageId: entry.pageId, relPath: cur }, String(since))
      this.plan.setState(entry, 'waiting', { code: 'file_in_use', message: 'Waiting for the file to close.' })
    } else {
      this.plan.setState(entry, 'waiting', { code: 'not_stable', message: 'Waiting for the file to settle.' })
    }
    if (entry.kind === 'folder' && L.item) {
      this.ctx.registerFolder(L.item.relPath, {
        spaceId: entry.spaceId, parent: { type: 'existing', pageId: entry.pageId },
      })
    }
  }

  // ── R deleted: archived in Nessie (R4, R5, C2, C5b) ──────────────────────

  private remoteDeleted(state: EntryPlanState, cur: string): void {
    const { entry, L } = state
    if (L!.change === 'deleted') {
      this.plan.add(PHASE.bookkeeping, { type: 'forgetEntry', pageId: entry.pageId, relPath: entry.relPath })
      return
    }
    if (isAncestorIn(entry.relPath, this.decisions.trashedFolders)) return
    const underRecreated = this.recreatedAncestor(entry)
    if (entry.kind === 'folder') {
      if (this.decisions.recreate.has(entry.pageId)) {
        const twin = L!.item ? this.ctx.twinAt(cur, this.decisions.adoptedTwins) : null
        if (twin?.kind === 'folder') this.adoptTwin(entry, L!, twin, cur)
        else this.recreate(entry, L!, cur)
        if (this.decisions.recreateRowOnFolder.has(entry.pageId)) {
          this.plan.record('folder_deleted_in_nessie_child_recreated', { pageId: entry.pageId, relPath: cur }, entry.pageId)
        }
      } else if (!this.decisions.keepWhole.has(entry.pageId)) {
        this.trash(entry, L!, cur)
        this.decisions.trashedFolders.push(entry.relPath)
      }
      return
    }
    if (!L!.contentChanged && L!.change !== 'moved') {
      this.trash(entry, L!, cur)
      return
    }
    if (this.ctx.tooLarge(entry, L!, cur)) return
    const twin = L!.item ? this.ctx.twinAt(cur, this.decisions.adoptedTwins) : null
    if (twin && twin.kind !== 'folder') {
      // Another computer recreated it here first: the twin takes the path and
      // this file is adopted or kept beside it, as any item in its way (C6).
      this.plan.add(PHASE.bookkeeping, { type: 'forgetEntry', pageId: entry.pageId, relPath: entry.relPath })
      this.ctx.release(L!.item!)
      return
    }
    this.recreate(entry, L!, cur)
    const reason = underRecreated ? 'folder_deleted_in_nessie_child_recreated' : 'deleted_in_nessie_edit_kept'
    this.plan.record(reason, { pageId: entry.pageId, relPath: cur }, L!.contentHash ?? cur)
  }

  private recreatedAncestor(entry: SyncEntry): boolean {
    let parentId = entry.parentPageId
    while (parentId !== null) {
      if (this.decisions.recreate.has(parentId)) return true
      parentId = this.ctx.input.entries.find((candidate) => candidate.pageId === parentId)?.parentPageId ?? null
    }
    return false
  }

  private trash(entry: SyncEntry, L: LocalState, cur: string): void {
    this.plan.add(PHASE.vacate, {
      type: 'trashLocal',
      pageId: entry.pageId,
      relPath: cur,
      expect: { base: entry.base, local: this.ctx.expectNow(L, entry) },
    }, cur)
  }

  /** Another computer recreated this folder first: the local folder becomes that page's. */
  private adoptTwin(entry: SyncEntry, L: LocalState, twin: SyncPage, cur: string): void {
    this.decisions.adoptedTwins.push(twin.id)
    this.plan.add(PHASE.bookkeeping, { type: 'forgetEntry', pageId: entry.pageId, relPath: entry.relPath })
    this.plan.add(PHASE.materialize, { type: 'adopt', pageId: twin.id, relPath: cur, base: this.ctx.headBase(twin) }, cur)
    this.ctx.registerFolder(L.item!.relPath, { spaceId: twin.spaceId, parent: { type: 'existing', pageId: twin.id } })
  }

  /** A new page for content Nessie deleted; the old entry is dropped and the file re-tracked. */
  private recreate(entry: SyncEntry, L: LocalState, cur: string): void {
    const resolved = this.ctx.parentFor(parentPath(cur))
    const title = titleForLocalName(baseName(cur), entry.kind) ?? entry.title
    if (!resolved) return
    const pageKey = pageKeyFor(this.ctx.input.passId, cur)
    this.plan.add(PHASE.bookkeeping, { type: 'forgetEntry', pageId: entry.pageId, relPath: entry.relPath })
    this.plan.add(PHASE.creates, {
      type: 'createRemote',
      pageKey,
      relPath: cur,
      kind: entry.kind === 'folder' ? 'folder' : entry.kind === 'document' ? 'document' : 'file',
      spaceId: resolved.spaceId,
      parent: resolved.parent,
      title,
      expect: { base: null, local: this.ctx.expectNow(L, entry) },
    }, cur)
    if (entry.kind === 'folder' && L.item) {
      this.ctx.registerFolder(L.item.relPath, { spaceId: resolved.spaceId, parent: { type: 'pending', pageKey } })
    }
  }

  // ── L deleted, page present (R5, R4/C3, C5a, R1) ─────────────────────────

  private localDeleted(state: EntryPlanState): void {
    const { entry, R } = state
    const page = R.page!
    const want = this.ctx.wanted(state.mapped!)
    if (this.decisions.restore.has(entry.pageId)) {
      if (this.ctx.claim(page, want) === 'wait') return
      this.ctx.materialize(page, want, entry.kind === 'folder' ? null : entry.base)
      if (entry.kind === 'folder') {
        this.ctx.registerFolder(want, { spaceId: page.spaceId, parent: { type: 'existing', pageId: page.id } })
      }
      this.restoreRow(entry, R, want)
      return
    }
    if (isAncestorIn(entry.relPath, this.decisions.archivedFolders)) return
    this.decisions.archives.push({
      action: {
        type: 'archiveRemote',
        pageId: entry.pageId,
        operationKey: operationKeyFor('archive', entry.pageId, page.revision, ''),
        relPath: entry.relPath,
        heldDeleteBatchId: null,
        ...this.ctx.archivePrecondition(entry.pageId),
        expect: { base: this.ctx.rebased(entry, page), local: null },
      },
      affected: entry.kind === 'folder'
        ? this.ctx.input.entries.filter((other) => isWithin(other.relPath, entry.relPath)).length
        : 1,
      spaceId: entry.spaceId,
    })
    if (entry.kind === 'folder') this.decisions.archivedFolders.push(entry.relPath)
  }

  private restoreRow(entry: SyncEntry, R: RemoteState, want: string): void {
    const page = R.page!
    const discriminator = `${entry.base.versionId ?? ''}:${page.head?.versionId ?? ''}:${page.revision}`
    if (page.readOnly) {
      this.plan.record(readOnlyReasonCode(page.readOnlyReason), { pageId: entry.pageId, relPath: want }, discriminator)
      return
    }
    if (!R.contentChanged && !R.moved) return
    const parentDeleted = this.decisions.restore.has(entry.parentPageId ?? '')
    const reason = parentDeleted && entry.kind !== 'folder' ? 'folder_deleted_here_child_restored' : 'deleted_here_restored'
    this.plan.record(reason, { pageId: entry.pageId, relPath: want }, discriminator)
  }

  // ── Both present ─────────────────────────────────────────────────────────

  private present(state: EntryPlanState, cur: string): void {
    const { entry, L, R } = state
    const page = R.page!
    const local = L!
    const mapped = state.mapped!
    const want = this.ctx.wanted(mapped)
    const readOnly = page.readOnly || entry.kind === 'spreadsheet'
    const ownLocal = local.change === 'moved' ? this.localStructure(entry, local, cur) : null
    if (ownLocal === 'unplaceable') {
      this.ctx.release(local.item!)
      this.localDeleted({ ...state, L: { ...local, change: 'deleted', item: null } })
      return
    }
    const remoteRenamed = page.parentPageId !== entry.parentPageId || page.spaceId !== entry.spaceId
      || page.title !== entry.title || baseName(mapped).normalize('NFC') !== baseName(entry.relPath).normalize('NFC')

    // R1: a read-only page's local edit or rename is never sent.
    if (readOnly && (local.contentChanged || ownLocal)) {
      if (local.contentChanged) {
        if (this.ctx.awaitingFolderMove(cur)) return
        const slash = cur.lastIndexOf('/')
        const copy = this.ctx.reserve(`${cur.slice(0, slash + 1)}${quarantineCopyName(cur.slice(slash + 1), this.ctx.stamp)}`)
        this.plan.add(PHASE.vacate, {
          type: 'quarantine',
          pageId: entry.pageId,
          relPath: cur,
          copyRelPath: copy,
          reason: readOnlyReasonCode(page.readOnlyReason ?? (entry.kind === 'spreadsheet' ? 'spreadsheet' : null)),
          expect: { base: entry.base, local: this.ctx.expectNow(local, entry) },
        }, cur)
        this.ctx.movedLocally(cur, copy)
        if (this.ctx.claim(page, want) !== 'wait') this.ctx.materialize(page, want, entry.base)
      } else {
        this.moves.plan(entry, cur, want, local)
        this.plan.record(readOnlyReasonCode(page.readOnlyReason), { pageId: entry.pageId, relPath: want }, cur)
      }
      return
    }

    // A move into another space's folder is not sent: Nessie refuses it (v1).
    // The file goes back and the row says why; an edit made too uploads next pass.
    if (ownLocal && !remoteRenamed && ownLocal.spaceId !== page.spaceId) {
      const back = this.moves.plan(entry, cur, want, local)
      this.plan.record('moved_to_other_space', { pageId: entry.pageId, relPath: back }, `${page.revision}:${cur}`)
      // What is inside goes back with it, so it still resolves to this folder.
      if (entry.kind === 'folder') {
        this.ctx.registerFolder(local.item?.relPath ?? entry.relPath, {
          spaceId: page.spaceId, parent: { type: 'existing', pageId: entry.pageId },
        })
      }
      return
    }

    // A4: while a conflict row is open, divergence goes to its copy page.
    const open = openConflictOf(this.ctx, entry)
    if (open && local.contentChanged && entry.kind !== 'folder') {
      // Its name is still Nessie's to change (R6): the file follows a rename first.
      const at = (!ownLocal || remoteRenamed) && cur !== want ? this.moves.plan(entry, cur, want, local) : cur
      planDivergeIntoCopy(this.ctx, entry, local, page, R, at, open)
      return
    }

    // Both sides changed it to the same bytes (C33): nothing to send, nothing to keep apart.
    const sameAsHead = local.contentChanged && R.contentChanged && local.contentHash !== null
      && local.contentHash === page.head?.contentHash
    // C1, C24: both sides changed the content.
    if (local.contentChanged && R.contentChanged && !sameAsHead) {
      if (this.ctx.awaitingFolderMove(cur)) return
      planBothChanged(this.ctx, entry, local, page, cur, want, ownLocal !== null || remoteRenamed || cur !== want)
      return
    }

    // Structure (R6): server wins a name both sides changed (C4).
    let finalPath = cur
    if (ownLocal && remoteRenamed) {
      // A name both sides changed to the same name in another case is still
      // Nessie's spelling; only a different name is worth a row.
      if (cur !== want) finalPath = this.moves.plan(entry, cur, want, local)
      if (nameKey(cur) !== nameKey(want)) {
        this.plan.record('renamed_in_nessie', { pageId: entry.pageId, relPath: finalPath }, `${page.revision}:${cur}`)
      } else if (cur === want && entry.kind !== 'folder' && !local.contentChanged && !R.contentChanged) {
        // Both sides made the same rename: the entry takes the new place.
        const base = this.ctx.rebased(entry, page)
        this.plan.add(PHASE.materialize, { type: 'adopt', pageId: entry.pageId, relPath: cur, base }, cur)
      }
    } else if (ownLocal) {
      this.plan.add(PHASE.remoteMoves, {
        type: 'moveRemote',
        pageId: entry.pageId,
        operationKey: operationKeyFor('move', entry.pageId, page.revision, ownLocal.spaceId,
          JSON.stringify(ownLocal.parent), ownLocal.title),
        fromRelPath: entry.relPath,
        toRelPath: cur,
        spaceId: ownLocal.spaceId,
        parent: ownLocal.parent,
        title: ownLocal.title,
        expect: { base: this.ctx.headBase(page), local: this.ctx.expectNow(local, entry) },
      }, cur)
      this.ctx.movedRemotely(want, cur)
    } else if (cur !== want) {
      finalPath = this.moves.plan(entry, cur, want, local)
    }
    if (entry.kind === 'folder') {
      this.ctx.registerFolder(local.item?.relPath ?? entry.relPath, {
        spaceId: page.spaceId, parent: { type: 'existing', pageId: entry.pageId },
      })
      if (!this.plan.touches(entry.pageId)) this.settled.add(entry.pageId)
      return
    }

    // Content.
    if (sameAsHead) {
      this.plan.add(PHASE.materialize, { type: 'adopt', pageId: entry.pageId, relPath: finalPath, base: this.ctx.headBase(page) }, finalPath)
    } else if (local.contentChanged) {
      if (this.ctx.tooLarge(entry, local, finalPath)) return
      this.plan.add(PHASE.content, {
        type: 'upload',
        pageId: entry.pageId,
        operationKey: operationKeyFor('upload', entry.pageId, page.revision, local.contentHash ?? ''),
        relPath: finalPath,
        kind: entry.kind === 'document' ? 'document' : 'file',
        changeComment: SYNC_COMMENT(this.ctx.input.computerLabel),
        expect: { base: this.ctx.rebased(entry, page), local: this.ctx.expectNow(local, entry) },
      }, finalPath)
    } else if ((!ownLocal || remoteRenamed)
      && (R.contentChanged || R.renderingChanged || page.readOnly !== (entry.remote?.readOnly ?? page.readOnly))) {
      // (A move this pass sends first: replacing the file now would fail the move's
      // check and leave the entry at the new path under the old parent.)
      this.plan.add(PHASE.materialize, {
        type: 'download',
        pageId: entry.pageId,
        versionId: page.head!.versionId,
        relPath: finalPath,
        contentHash: page.head!.contentHash,
        byteLength: page.head!.byteLength,
        readOnly: page.readOnly,
        expect: { base: entry.base, local: this.ctx.expectNow(local, entry) },
      }, finalPath)
    }
    if (!this.plan.touches(entry.pageId)) this.settled.add(entry.pageId)
  }

  /**
   * What a local move asks of the page: a new parent, space or title. Null
   * when the move changes none (an enclosing folder moved, or the name only
   * differs in Unicode normalisation); `unplaceable` when the item left every
   * space (it is then a delete of the page and a local item that cannot sync).
   * A move into another space's folder is answered in `present` (it goes back).
   */
  private localStructure(
    entry: SyncEntry, local: LocalState, cur: string,
  ): { spaceId: string; parent: RemoteParent; title: string } | null | 'unplaceable' {
    const resolved = this.ctx.parentFor(parentPath(cur))
    if (!resolved) return 'unplaceable'
    const renamed = baseName(local.item!.relPath).normalize('NFC') !== baseName(entry.relPath).normalize('NFC')
    const title = renamed ? titleForLocalName(baseName(cur), entry.kind) : entry.title
    if (title === null) return 'unplaceable'
    const sameParent = resolved.parent.type === 'existing' && resolved.parent.pageId === entry.parentPageId
    if (sameParent && resolved.spaceId === entry.spaceId && title === entry.title) return null
    return { spaceId: resolved.spaceId, parent: resolved.parent, title }
  }
}
