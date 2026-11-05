import type { FolderSyncConflictResolution, SyncPage } from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import type { EngineStore } from './engine-store.js'
import { FolderSyncLocalDriftError, confinedPath, hashFile, installFile, lstatOrNull, trashItem } from './local-fs.js'
import type { ConflictBook } from './report.js'
import type { FolderSyncPaths } from './state-files.js'
import { recordTrashed } from './trash-book.js'
import { isTransientSyncError } from './transport.js'
import type { KeepMineAction } from './types.js'

/**
 * A person's Keep mine / Keep Nessie's (A4, A12.2, C32). The choice acts on
 * the row as the person saw it: it applies only while the row's `occurredAt`,
 * the head version it was decided against and the copy's bytes still match.
 * Otherwise the row is re-reported open with a new `occurredAt` and the person
 * decides again. Applying a choice only changes local files; the next pass
 * carries it to Nessie the ordinary way — a trashed copy archives its page, a
 * canonical file holding the copy's bytes uploads.
 */

export type ResolutionRequest = {
  clientConflictId: string
  resolution: FolderSyncConflictResolution
  /** The `occurredAt` the person saw; null from the local console, which shows the live row. */
  expectedOccurredAt: string | null
}

export type ResolveContext = {
  teamDir: string
  paths: FolderSyncPaths
  store: EngineStore
  pages: ReadonlyMap<string, SyncPage>
  book: ConflictBook
  now: () => number
  security: StateSecurityDeps
}

export type ResolutionOutcome = 'resolved' | 'reopened' | 'not_found'

/**
 * Keep mine's replace, under its journal id: the staged copy and the
 * canonical file renamed aside carry the id, so a replay after a crash puts
 * the canonical file back (`recoverInstall`) and then finishes the replace.
 * Done already when the canonical file holds the copy's bytes.
 */
export const runKeepMine = async (teamDir: string, action: KeepMineAction, actionId: string): Promise<void> => {
  const canonical = confinedPath(teamDir, action.relPath)
  const copy = confinedPath(teamDir, action.copyRelPath)
  const found = await lstatOrNull(canonical)
  const hash = found?.type === 'file' ? await hashFile(canonical) : null
  if (hash === action.expect.copyHash) return
  const copyFound = await lstatOrNull(copy)
  const copyHash = copyFound?.type === 'file' ? await hashFile(copy) : null
  if (hash !== action.expect.canonicalHash || copyHash !== action.expect.copyHash) {
    throw new FolderSyncLocalDriftError(`${action.relPath} or its copy changed before Keep mine.`)
  }
  await installFile(teamDir, copy, canonical, { expectHash: hash, readOnly: false, keepSource: true, tag: actionId })
}

export const applyResolution = async (ctx: ResolveContext, request: ResolutionRequest): Promise<ResolutionOutcome> => {
  const row = ctx.book.get(request.clientConflictId)
  if (!row || row.state === 'resolved') return 'not_found'
  const report = row.report
  const clearOpenConflict = async () => {
    for (const entry of ctx.store.entries()) {
      if (entry.openConflict?.clientConflictId === report.clientConflictId) {
        await ctx.store.put({ ...entry, openConflict: null, state: entry.state === 'conflict' || entry.state === 'preserved' ? 'synced' : entry.state })
      }
    }
  }
  if (request.resolution === 'dismiss' || report.kind === 'info' || report.kind === 'error') {
    await clearOpenConflict()
    await ctx.book.resolve(report.clientConflictId, request.resolution)
    return 'resolved'
  }

  const copyPath = report.copy ? confinedPath(ctx.teamDir, report.copy.relPath) : null
  const copyFound = copyPath ? await lstatOrNull(copyPath) : null
  const copyHash = copyFound?.type === 'file' ? await hashFile(copyPath!) : null
  const head = report.pageId ? ctx.pages.get(report.pageId)?.head?.versionId ?? null : null
  const entry = report.pageId ? ctx.store.entry(report.pageId) : null
  const canonical = entry ? confinedPath(ctx.teamDir, entry.relPath) : null
  const canonicalFound = canonical ? await lstatOrNull(canonical) : null
  const canonicalHash = canonicalFound?.type === 'file' ? await hashFile(canonical!) : null
  const stale = (request.expectedOccurredAt !== null && request.expectedOccurredAt !== report.occurredAt)
    || (report.kind === 'conflicted_copy' && report.headVersionId !== undefined && report.headVersionId !== head)
    || (report.copy?.contentHash !== undefined && copyHash !== null && copyHash !== report.copy.contentHash)
    || (request.resolution === 'keep_mine' && report.kind === 'conflicted_copy' && copyHash === null)
    // A choice can arrive before the scanner preserves a new canonical save.
    || (report.kind === 'conflicted_copy'
      && (!entry || (canonicalHash !== entry.local?.contentHash && canonicalHash !== copyHash)))
  if (stale) {
    await ctx.book.reopen(report.clientConflictId, {
      ...report,
      occurredAt: new Date(ctx.now()).toISOString(),
      headVersionId: head,
      ...(report.copy
        ? {
          copy: {
            relPath: report.copy.relPath, pageId: report.copy.pageId, ...(copyHash ? { contentHash: copyHash } : {}),
          },
        }
        : {}),
    })
    return 'reopened'
  }

  if (report.kind === 'conflicted_copy' && request.resolution === 'keep_mine' && report.copy && copyHash) {
    // The canonical file takes the copy's bytes; the next pass uploads it as a new version.
    const action: KeepMineAction = {
      type: 'keepMine', pageId: report.pageId, relPath: report.relPath, copyRelPath: report.copy.relPath,
      expect: { canonicalHash, copyHash },
    }
    const actionId = await ctx.store.begin(action)
    try {
      await runKeepMine(ctx.teamDir, action, actionId)
    } catch (error) {
      // As a planned action: what stops the pass leaves it pending for the replay.
      if (!isTransientSyncError(error)) await ctx.store.finish(actionId)
      throw error
    }
    await ctx.store.finish(actionId)
  }
  if (report.kind === 'conflicted_copy' && request.resolution === 'keep_nessie' && report.pageId) {
    // The canonical file may still hold edits made while the row was open, kept
    // in the copy (A4). Keep Nessie's must not send them as the canonical page:
    // the entry agrees on Nessie's version and the next pass fetches its bytes.
    const entry = ctx.store.entry(report.pageId)
    const canonical = entry ? confinedPath(ctx.teamDir, entry.relPath) : null
    const found = canonical ? await lstatOrNull(canonical) : null
    const hash = found?.type === 'file' ? await hashFile(canonical!) : null
    if (entry && hash !== null && hash !== entry.base.contentHash && hash === entry.openConflict?.copyHash) {
      await ctx.store.put({ ...entry, base: { ...entry.base, contentHash: hash } })
    }
  }
  const discardCopy = report.copy && copyFound
    && (report.kind === 'conflicted_copy' || request.resolution === 'keep_nessie')
  if (discardCopy) {
    const kept = await trashItem(
      ctx.paths.trash, ctx.teamDir, report.copy!.relPath,
      { fileId: copyFound!.fileId, contentHash: copyHash }, ctx.now(),
    )
    await recordTrashed(ctx.paths, report.copy!.relPath, kept, ctx.now(), ctx.security)
  }
  await clearOpenConflict()
  await ctx.book.resolve(report.clientConflictId, request.resolution)
  return 'resolved'
}
