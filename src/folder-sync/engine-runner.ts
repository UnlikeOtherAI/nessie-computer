import { mkdir } from 'node:fs/promises'

import type { ConflictReport } from '@nessie/executor-protocol'

import { headBaseOf, remoteOf, rewritePaths } from './engine-entries.js'
import { recordFailure, type BusyLedger } from './engine-failures.js'
import { runKeepMine } from './engine-resolve.js'
import {
  recordOnDisk,
  resolveParent,
  runCreate,
  runDownload,
  runMerge,
  runUpload,
  type RunnerContext,
} from './engine-writes.js'
import { resolveInstall } from './index-store.js'
import {
  FolderSyncLocalDriftError,
  assertLinkFreeParents,
  confinedPath,
  fsPath,
  hashFile,
  lstatOrNull,
  matchesExpected,
  moveItem,
  recoverInstall,
  setReadOnly,
  trashItem,
} from './local-fs.js'
import { baseName, isWithin, nameKey } from './path-mapping.js'
import { conflictReportForCopy } from './reconcile-model.js'
import { recordTrashed } from './trash-book.js'
import { isTransientSyncError } from './transport.js'
import type { ConflictCopyAction, ExpectedLocal, ReconcileAction } from './types.js'

/**
 * Carries out a plan (plan §2.7, amendments A8, A12.9). Actions run in plan
 * order; consecutive downloads (3 at a time) and uploads (2) run together when
 * they touch different pages and paths. Every side effect is journaled first;
 * every action re-checks what the plan saw and, on any drift, is dropped —
 * with every later action on the same page or path — and the pass asks to be
 * planned again. A failure that says nothing about the request (the network, a
 * 5xx) aborts the pass and leaves the action pending, so the next pass replays
 * it first with the same operation key (C28) instead of re-planning around it.
 */

const BOOKKEEPING = new Set<ReconcileAction['type']>(['recordConflict', 'setEntryState', 'forgetEntry', 'holdDelete', 'adopt'])
const PARKING = '.nessie-sync-move-'


const pathsOf = (action: ReconcileAction): string[] => {
  switch (action.type) {
    case 'moveLocal': case 'moveRemote': return [action.fromRelPath, action.toRelPath]
    case 'conflictCopy': case 'quarantine': case 'keepMine': return [action.relPath, action.copyRelPath]
    case 'recordConflict': case 'setEntryState': return []
    default: return [action.relPath]
  }
}

const pageOf = (action: ReconcileAction): string | null =>
  action.type === 'recordConflict' ? action.conflict.pageId : ('pageId' in action ? action.pageId : null)

const related = (a: string, b: string): boolean => isWithin(a, b) || isWithin(b, a)

const isUploadLike = (action: ReconcileAction): boolean =>
  action.type === 'upload' || action.type === 'merge' || (action.type === 'createRemote' && action.kind !== 'folder')

export class ActionRunner {
  private readonly blockedPages = new Set<string>()
  private readonly blockedPaths: string[] = []
  private readonly preBegun = new Map<ReconcileAction, string>()
  private readonly copyRows: Array<{ action: ConflictCopyAction; headVersionId: string | null }> = []
  readonly touched = new Set<string>()
  readonly remainder = { uploads: 0, downloads: 0 }
  executed = 0
  replanNeeded = false
  diskFull = false

  constructor(private readonly ctx: RunnerContext, private readonly busy: BusyLedger) {}

  /** Run a plan. Pending actions (replayed from the journal) keep their journal ids. */
  async run(
    actions: readonly ReconcileAction[], pending: ReadonlyMap<ReconcileAction, string> = new Map(),
  ): Promise<void> {
    for (const [action, id] of pending) this.preBegun.set(action, id)
    for (let index = 0; index < actions.length;) {
      const action = actions[index]!
      if (action.type !== 'download' && action.type !== 'upload') {
        await this.execute(action, actions, index)
        index += 1
        continue
      }
      const batch: number[] = [index]
      let next = index + 1
      while (next < actions.length && actions[next]!.type === action.type && batch.length < 32
        && batch.every((i) => this.independent(actions[i]!, actions[next]!))) {
        batch.push(next)
        next += 1
      }
      const limit = action.type === 'download' ? this.ctx.concurrency.downloads : this.ctx.concurrency.uploads
      let cursor = 0
      // A failure that ends the pass stops the batch, but only once every
      // transfer already started has finished: none may outlive the pass and
      // race the next one (or a restarted engine) over the same journal.
      let stop: { error: unknown } | null = null
      await Promise.all(Array.from({ length: Math.min(limit, batch.length) }, async () => {
        while (cursor < batch.length && stop === null) {
          const i = batch[cursor++]!
          try {
            await this.execute(actions[i]!, actions, i)
          } catch (error) {
            stop ??= { error }
          }
        }
      }))
      if (stop !== null) throw (stop as { error: unknown }).error
      index = next
    }
    // Follow-ups journaled ahead of a step that then failed never ran: they are not pending.
    for (const id of this.preBegun.values()) await this.ctx.store.finish(id)
    this.preBegun.clear()
  }

  /**
   * A8 replay: installs whose `done` never came. A file renamed aside comes
   * back first; then the target's hash decides whether the install happened.
   * Returns the journal ids it settled.
   */
  async settleInstalls(): Promise<Set<string>> {
    const settled = new Set<string>()
    for (const install of this.ctx.store.index.installs) {
      const target = confinedPath(this.ctx.teamDir, install.relPath)
      await recoverInstall(target, install.actionId)
      const found = await lstatOrNull(target)
      const hash = found?.type === 'file' ? await hashFile(target) : null
      if (resolveInstall(install, hash) === 'completed') {
        const page = this.ctx.pages.get(install.pageId)
        if (page) {
          await recordOnDisk(this.ctx, page, install.relPath, {
            versionId: install.versionId, revision: install.revision, contentHash: install.hash,
          })
        }
        await this.ctx.store.finish(install.actionId)
        settled.add(install.actionId)
      }
    }
    return settled
  }

  /**
   * A crash inside a replace (a merge, a re-rendered file) can leave the
   * person's file renamed aside under the action's id: put it back, or drop
   * the leftover, before the action replays.
   */
  async recoverReplaces(pending: ReadonlyArray<{ actionId: string; action: ReconcileAction }>): Promise<void> {
    for (const { actionId, action } of pending) {
      for (const relPath of pathsOf(action)) {
        try {
          await recoverInstall(confinedPath(this.ctx.teamDir, relPath), actionId)
        } catch {
          // A refused or held path: the replayed action re-checks it anyway.
        }
      }
    }
  }

  /** The conflicted-copy rows of this pass, raised last (A12.9). */
  copyReports(occurredAt: string): ConflictReport[] {
    return this.copyRows.map(({ action, headVersionId }) => {
      const holder = action.pageId ? this.ctx.store.entry(action.pageId) : undefined
      const pageId = this.ctx.copiesCreated.get(action.copyRelPath) ?? holder?.openConflict?.copyPageId ?? null
      const hash = action.expect.local?.contentHash
      return {
        ...conflictReportForCopy(action, occurredAt),
        copy: { relPath: action.copyRelPath, pageId, ...(hash ? { contentHash: hash } : {}) },
        headVersionId,
      }
    })
  }

  private independent(a: ReconcileAction, b: ReconcileAction): boolean {
    const pa = pageOf(a)
    if (pa !== null && pa === pageOf(b)) return false
    return pathsOf(a).every((x) => pathsOf(b).every((y) => !related(x, y)))
  }

  private isBlocked(action: ReconcileAction): boolean {
    const page = pageOf(action)
    if (page !== null && this.blockedPages.has(page)) return true
    return pathsOf(action).some((path) => this.blockedPaths.some((blocked) => related(path, blocked)))
  }

  private block(action: ReconcileAction): void {
    const page = pageOf(action)
    if (page !== null) this.blockedPages.add(page)
    this.blockedPaths.push(...pathsOf(action))
    this.replanNeeded = true
  }

  private countRemaining(action: ReconcileAction): void {
    if (action.type === 'download') this.remainder.downloads += 1
    else if (isUploadLike(action)) this.remainder.uploads += 1
  }

  private async execute(action: ReconcileAction, all: readonly ReconcileAction[], index: number): Promise<void> {
    if (this.isBlocked(action) || (action.type === 'download' && this.diskFull)) {
      this.countRemaining(action)
      return
    }
    if (BOOKKEEPING.has(action.type)) {
      await this.bookkeep(action)
      return
    }
    const id = this.preBegun.get(action) ?? await this.ctx.store.begin(action)
    this.preBegun.delete(action)
    try {
      await this.dispatch(action, id, all, index)
      this.executed += 1
      const page = pageOf(action)
      if (page !== null) this.touched.add(page)
    } catch (error) {
      if (isTransientSyncError(error)) throw error
      this.countRemaining(action)
      await this.ctx.store.finish(id)
      await this.failed(action, error)
      return
    }
    await this.ctx.store.finish(id)
  }

  private async dispatch(action: ReconcileAction, id: string, all: readonly ReconcileAction[], index: number) {
    const { ctx } = this
    switch (action.type) {
      case 'download': return runDownload(ctx, action, id)
      case 'upload': return runUpload(ctx, action, id)
      case 'createRemote': return runCreate(ctx, action, id)
      case 'merge':
        // The keep-both steps that follow a merge are journaled with it, so a
        // replayed merge that falls back resumes the whole chain (A12.9).
        await this.preBegin(all, index, this.followsCopy(action.fallback))
        if (!await runMerge(ctx, action, id)) await this.conflictCopy(action.fallback, all, index)
        return
      case 'conflictCopy': return this.conflictCopy(action, all, index)
      case 'quarantine': return this.quarantine(action)
      case 'moveLocal': return this.moveLocal(action, all, index)
      case 'trashLocal': return this.trash(action)
      case 'mkdir': return this.mkdir(action)
      case 'moveRemote': return this.moveRemote(action)
      case 'archiveRemote': return this.archive(action)
      case 'keepMine': return runKeepMine(ctx.teamDir, action, id)
      default: throw new Error(`Unexpected action ${action.type}.`)
    }
  }

  private async bookkeep(action: ReconcileAction): Promise<void> {
    const { ctx } = this
    if (action.type === 'recordConflict') {
      const head = action.conflict.pageId ? ctx.pages.get(action.conflict.pageId)?.head?.versionId ?? null : null
      await ctx.book.add([{ ...action.conflict, headVersionId: head }])
      await ctx.store.rememberConflicts([action.conflict.clientConflictId])
    } else if (action.type === 'forgetEntry') {
      await ctx.store.forget(action.pageId)
    } else if (action.type === 'holdDelete' || action.type === 'setEntryState') {
      const entry = ctx.store.entry(action.pageId)
      if (!entry) return
      const rest: typeof entry = { ...entry }
      delete rest.detail
      const state = action.type === 'holdDelete' ? 'held_delete' as const : action.state
      const detail = action.type === 'setEntryState' ? action.detail : null
      await ctx.store.put({ ...rest, state, ...(detail ? { detail } : {}) })
    } else if (action.type === 'adopt') {
      const page = ctx.pages.get(action.pageId)
      const absolute = confinedPath(ctx.teamDir, action.relPath)
      const expected = { fileId: null, contentHash: action.base.contentHash }
      if (!page || !await matchesExpected(absolute, expected)) {
        this.block(action)
        return
      }
      await recordOnDisk(ctx, page, action.relPath, action.base)
    }
  }

  /** A move whose effect is already on disk (a replay after a crash) counts as done. */
  private async alreadyMoved(from: string, to: string, expected: ExpectedLocal | null): Promise<boolean> {
    return await lstatOrNull(from) === null && expected !== null && await matchesExpected(to, expected)
  }

  private async move(fromRel: string, toRel: string, expected: ExpectedLocal | null): Promise<void> {
    const from = confinedPath(this.ctx.teamDir, fromRel)
    const to = confinedPath(this.ctx.teamDir, toRel)
    if (await this.alreadyMoved(from, to, expected)) return
    await moveItem(this.ctx.teamDir, from, to, expected)
  }

  /** The steps of a keep-both after its copy: create the copy page, download the head. */
  private followsCopy(action: ConflictCopyAction): (later: ReconcileAction) => boolean {
    return (later) => (later.type === 'createRemote' && later.relPath === action.copyRelPath)
      || (later.type === 'download' && later.relPath === action.relPath)
  }

  /** Journal the steps that must follow `index` before the first of them runs. */
  private async preBegin(all: readonly ReconcileAction[], index: number, pick: (a: ReconcileAction) => boolean) {
    for (const later of all.slice(index + 1)) {
      if (pick(later) && !this.preBegun.has(later)) this.preBegun.set(later, await this.ctx.store.begin(later))
    }
  }

  /**
   * R2 keep-both (A12.9): the open conflict is persisted first, the whole chain
   * (copy aside → create the copy page → download the head) is journaled, then
   * the local copy is made. The row is raised after the pass, last.
   */
  private async conflictCopy(action: ConflictCopyAction, all: readonly ReconcileAction[], index: number) {
    const { ctx } = this
    const entry = action.pageId ? ctx.store.entry(action.pageId) : undefined
    if (entry) {
      const { clientConflictId } = conflictReportForCopy(action, new Date(ctx.now()).toISOString())
      await ctx.store.put({
        ...entry,
        state: 'conflict',
        openConflict: {
          clientConflictId, copyPageId: null, copyRelPath: action.copyRelPath,
          copyHash: action.expect.local?.contentHash ?? null,
        },
      })
    }
    await this.preBegin(all, index, this.followsCopy(action))
    try {
      await this.move(action.relPath, action.copyRelPath, action.expect.local)
    } catch (error) {
      // Nothing was copied (the file changed, or is held): no conflict is open.
      // A crash is not this: its replay finds the copy made or makes it.
      if (entry && !isTransientSyncError(error)) await ctx.store.put(entry)
      throw error
    }
    const current = action.pageId ? ctx.store.entry(action.pageId) : undefined
    if (current) await ctx.store.put({ ...current, local: null })
    const headVersionId = action.pageId ? ctx.pages.get(action.pageId)?.head?.versionId ?? null : null
    this.copyRows.push({ action, headVersionId })
  }

  /** R1: the edit moves aside, is never sent, and the row says why. */
  private async quarantine(action: Extract<ReconcileAction, { type: 'quarantine' }>): Promise<void> {
    const { ctx } = this
    await this.move(action.relPath, action.copyRelPath, action.expect.local)
    await setReadOnly(confinedPath(ctx.teamDir, action.copyRelPath), false).catch(() => undefined)
    const report = conflictReportForCopy(action, new Date(ctx.now()).toISOString())
    const hash = action.expect.local?.contentHash
    await ctx.book.add([{
      ...report,
      copy: { relPath: action.copyRelPath, pageId: null, ...(hash ? { contentHash: hash } : {}) },
      headVersionId: ctx.pages.get(action.pageId)?.head?.versionId ?? null,
    }])
    await ctx.store.rememberConflicts([report.clientConflictId])
    const entry = ctx.store.entry(action.pageId)
    if (entry) await ctx.store.put({ ...entry, local: null })
  }

  private async moveLocal(action: Extract<ReconcileAction, { type: 'moveLocal' }>, all: readonly ReconcileAction[], index: number) {
    const { ctx } = this
    const parking = baseName(action.toRelPath).startsWith(PARKING)
    // A swap or a lift goes through a hidden parking name: every leg leaving it is journaled before the first runs.
    if (parking) {
      await this.preBegin(all, index, (later) => later.type === 'moveLocal' && isWithin(later.fromRelPath, action.toRelPath))
    }
    const moved = await lstatOrNull(confinedPath(ctx.teamDir, action.fromRelPath))
      ?? await lstatOrNull(confinedPath(ctx.teamDir, action.toRelPath))
    await this.move(action.fromRelPath, action.toRelPath, action.expect.local)
    const carried = ctx.store.entriesWithin(action.fromRelPath).filter((entry) => entry.relPath !== action.fromRelPath
      || entry.pageId === action.pageId || (entry.kind === 'folder') === (moved?.type === 'directory'))
    for (const entry of rewritePaths(carried, action.fromRelPath, action.toRelPath)) {
      await ctx.store.put(entry)
      this.touched.add(entry.pageId)
    }
    // The page's own item is at the target now, wherever its entry last saw it
    // (a person may have moved it first): a stale path would be planned again forever.
    const own = action.pageId ? ctx.store.entry(action.pageId) : undefined
    if (own && own.relPath !== action.toRelPath) await ctx.store.put({ ...own, relPath: action.toRelPath })
    const page = action.pageId ? ctx.pages.get(action.pageId) : undefined
    const entry = action.pageId ? ctx.store.entry(action.pageId) : undefined
    if (page && entry && !parking) {
      const agreed = (page.head?.versionId ?? null) === entry.base.versionId
      await ctx.store.put({
        ...entry, title: page.title, parentPageId: page.parentPageId, spaceId: page.spaceId, remote: remoteOf(page),
        base: agreed ? { ...entry.base, revision: page.revision } : entry.base,
      })
    }
  }

  private async trash(action: Extract<ReconcileAction, { type: 'trashLocal' }>): Promise<void> {
    const { ctx } = this
    const source = confinedPath(ctx.teamDir, action.relPath)
    const found = await lstatOrNull(source)
    if (found !== null) {
      const kept = await trashItem(ctx.paths.trash, ctx.teamDir, action.relPath, action.expect.local, ctx.now())
      await recordTrashed(ctx.paths, action.relPath, kept, ctx.now(), ctx.security)
    }
    const gone = ctx.store.entriesWithin(action.relPath).filter((entry) => entry.relPath !== action.relPath
      || entry.pageId === action.pageId || found === null || (entry.kind === 'folder') === (found.type === 'directory'))
    for (const entry of gone) await ctx.store.forget(entry.pageId)
    if (action.pageId) await ctx.store.forget(action.pageId)
  }

  private async mkdir(action: Extract<ReconcileAction, { type: 'mkdir' }>): Promise<void> {
    const { ctx } = this
    const page = ctx.pages.get(action.pageId)
    if (!page) throw new FolderSyncLocalDriftError('The folder is gone.')
    const absolute = confinedPath(ctx.teamDir, action.relPath)
    await assertLinkFreeParents(ctx.teamDir, absolute, true)
    const found = await lstatOrNull(absolute)
    if (found !== null && found.type !== 'directory') throw new FolderSyncLocalDriftError('Something else took the path.')
    // A directory another entry still holds is not this page's to take: two pages would share it.
    if (found !== null && ctx.store.entries().some((other) => other.pageId !== action.pageId
      && nameKey(other.relPath) === nameKey(action.relPath))) {
      throw new FolderSyncLocalDriftError('Another entry holds this folder.')
    }
    if (found === null) await mkdir(fsPath(absolute))
    await recordOnDisk(ctx, page, action.relPath, headBaseOf(page))
  }

  private async moveRemote(action: Extract<ReconcileAction, { type: 'moveRemote' }>): Promise<void> {
    const { ctx } = this
    if (!await matchesExpected(confinedPath(ctx.teamDir, action.toRelPath), action.expect.local)) {
      throw new FolderSyncLocalDriftError('The item moved again.')
    }
    const parentPageId = resolveParent(ctx, action.parent, action.toRelPath)
    if (parentPageId === undefined) throw new FolderSyncLocalDriftError('The new parent was not created.')
    const answer = await ctx.transport.move({
      operationKey: action.operationKey, pageId: action.pageId,
      baseRevision: ctx.ownRevisions.get(action.pageId) ?? action.expect.base.revision,
      spaceId: action.spaceId, parentPageId, title: action.title,
    })
    const page = answer.page
    ctx.pages.set(page.id, page)
    ctx.ownRevisions.set(page.id, page.revision)
    const below = ctx.store.entriesWithin(action.fromRelPath)
    for (const moved of rewritePaths(below, action.fromRelPath, action.toRelPath)) {
      await ctx.store.put(moved)
    }
    const entry = ctx.store.entry(page.id)
    if (entry) {
      await ctx.store.put({
        ...entry, relPath: action.toRelPath, title: page.title, parentPageId: page.parentPageId, spaceId: page.spaceId,
        remote: remoteOf(page), base: { ...entry.base, revision: page.revision },
      })
    }
  }

  private async archive(action: Extract<ReconcileAction, { type: 'archiveRemote' }>): Promise<void> {
    const { ctx } = this
    if (!await matchesExpected(confinedPath(ctx.teamDir, action.relPath), null)) {
      throw new FolderSyncLocalDriftError('The item came back.')
    }
    const answer = await ctx.transport.archive({
      operationKey: action.operationKey, pageId: action.pageId,
      baseRevision: ctx.ownRevisions.get(action.pageId) ?? action.expect.base.revision,
      descendantCount: action.descendantCount, descendantHash: action.descendantHash,
      heldDeleteBatchId: action.heldDeleteBatchId,
    })
    const archived = new Set(answer.archivedPageIds)
    for (const entry of ctx.store.entriesWithin(action.relPath)) archived.add(entry.pageId)
    for (const pageId of archived) {
      ctx.pages.delete(pageId)
      ctx.gone.add(pageId)
      await ctx.store.forget(pageId)
    }
  }

  /** What a failed action means for its entry, the manifest and the pass. */
  private async failed(action: ReconcileAction, error: unknown): Promise<void> {
    this.block(action)
    const outcome = await recordFailure(this.ctx, this.busy, action, pageOf(action), pathsOf(action)[0] ?? '', error)
    if (outcome === 'disk_full') this.diskFull = true
  }
}
