import { FOLDER_SYNC_MERGE_MAX_BYTES, type SyncPage } from '@nessie/executor-protocol'

import type { LocalState, RemoteState } from './reconcile-classify.js'
import type { ReconcileContext } from './reconcile-context.js'
import { PHASE, operationKeyFor, pageKeyFor } from './reconcile-model.js'
import { baseName, parentPath, titleForLocalName } from './path-mapping.js'
import type { ExpectedLocal, RemoteParent, SyncEntry } from './types.js'

/**
 * Both sides changed one file's bytes (plan §3 C1, C24; amendments A4,
 * A12.9): merge text cleanly (R3), otherwise keep both (R2) — and, while
 * the conflict row it raised is open, send further local edits to its copy.
 * `reconcile-entries.ts` decides when an entry is here.
 */

/** The change comment of a version this computer sends. */
export const SYNC_COMMENT = (computer: string) => `Synced from ${computer}`
const MERGE_COMMENT = (computer: string) => `Merged edits from ${computer}`

/**
 * R3 applies to exact Markdown documents and text files within the merge cap,
 * and only while the base text is held locally (A7): a missing base is R2,
 * never a fabricated ancestor.
 */
const mergeable = (entry: SyncEntry, page: SyncPage, size: number, hasBase: boolean): boolean => {
  if (!hasBase || entry.base.versionId === null || !page.head) return false
  if (size > FOLDER_SYNC_MERGE_MAX_BYTES || page.head.byteLength > FOLDER_SYNC_MERGE_MAX_BYTES) return false
  if (entry.kind === 'document') return page.fidelity === 'exact'
  return entry.kind === 'file'
    && (page.head.mime.startsWith('text/') || ['md', 'markdown', 'txt'].includes(page.head.extension ?? ''))
}

/** C1: merge text cleanly (R3), otherwise keep both (R2). */
export const planBothChanged = (
  ctx: ReconcileContext, entry: SyncEntry, local: LocalState, page: SyncPage, cur: string, want: string,
  structureChanged: boolean,
): void => {
  if (ctx.tooLarge(entry, local, cur)) return
  const copy = ctx.reserve(ctx.conflictedCopyPath(cur))
  const expectLocal = ctx.expectNow(local, entry)
  const conflictCopy = {
    type: 'conflictCopy' as const,
    pageId: entry.pageId,
    relPath: cur,
    copyRelPath: copy,
    reason: 'edited_on_both_sides' as const,
    expect: { base: entry.base, local: expectLocal },
  }
  const merge = !structureChanged && mergeable(
    entry, page, local.item?.size ?? Number.POSITIVE_INFINITY, ctx.input.mergeBases.has(entry.pageId),
  )
  if (merge) {
    ctx.plan.add(PHASE.content, {
      type: 'merge',
      pageId: entry.pageId,
      operationKey: operationKeyFor('merge', entry.pageId, page.revision, local.contentHash ?? '', page.head!.versionId),
      relPath: cur,
      baseVersionId: entry.base.versionId!,
      remoteVersionId: page.head!.versionId,
      changeComment: MERGE_COMMENT(ctx.input.computerLabel),
      expect: { base: ctx.headBase(page), local: expectLocal },
      fallback: conflictCopy,
    }, cur)
  } else {
    ctx.plan.add(PHASE.vacate, conflictCopy, cur)
  }
  // Keep both (A12.9): copy aside → create the copy page → download the
  // head. After a merge fallback the copy exists and the path is free;
  // after a clean merge neither holds, so the follow-ups fail their checks
  // and drop.
  ctx.movedLocally(cur, copy)
  const resolved = ctx.parentFor(parentPath(copy))
  const title = titleForLocalName(baseName(copy), entry.kind)
  if (resolved && title !== null) createCopyPage(ctx, entry, copy, resolved, title, expectLocal, merge)
  if (ctx.claim(page, want) !== 'wait') ctx.materialize(page, want, entry.base, PHASE.mergeFollowUps)
}

const createCopyPage = (
  ctx: ReconcileContext, entry: SyncEntry, copy: string, resolved: { spaceId: string; parent: RemoteParent },
  title: string,
  expectLocal: ExpectedLocal | null, merge: boolean,
): void => {
  ctx.plan.add(merge ? PHASE.mergeFollowUps : PHASE.creates, {
    type: 'createRemote',
    pageKey: pageKeyFor(ctx.input.passId, copy),
    relPath: copy,
    kind: entry.kind === 'document' ? 'document' : 'file',
    spaceId: resolved.spaceId,
    parent: resolved.parent,
    title,
    expect: { base: null, local: expectLocal },
  }, copy)
}

/** The entry's open conflict, unless its copy page has since gone from Nessie. */
export const openConflictOf = (
  ctx: ReconcileContext, entry: SyncEntry,
): NonNullable<SyncEntry['openConflict']> | null => {
  const open = entry.openConflict ?? null
  if (!open) return null
  if (open.copyPageId !== null && !ctx.pages.has(open.copyPageId)) return null
  return open
}

/**
 * A4: the canonical file moved on again while its conflict row is open (an
 * editor still saving it). The new bytes become a new version of the copy
 * page; the canonical page is not written. Once the copy holds them, a newer
 * Nessie head may replace the canonical file again — the bytes are kept.
 */
export const planDivergeIntoCopy = (
  ctx: ReconcileContext, entry: SyncEntry, local: LocalState, page: SyncPage, R: RemoteState, cur: string,
  open: NonNullable<SyncEntry['openConflict']>,
): void => {
  const detail = { code: 'edited_on_both_sides' as const, message: 'Your edits go to the conflicted copy.' }
  if (open.copyPageId === null) {
    ctx.plan.setState(entry, 'conflict', detail)
    return
  }
  const copyPage = ctx.pages.get(open.copyPageId)!
  const preserved = local.contentHash !== null
    && (local.contentHash === copyPage.head?.contentHash || local.contentHash === open.copyHash)
  ctx.plan.setState(entry, preserved ? 'preserved' : 'conflict', detail)
  if (preserved) {
    if (R.contentChanged && ctx.claim(page, cur) !== 'wait') {
      ctx.plan.add(PHASE.materialize, {
        type: 'download',
        pageId: entry.pageId,
        versionId: page.head!.versionId,
        relPath: cur,
        contentHash: page.head!.contentHash,
        byteLength: page.head!.byteLength,
        readOnly: page.readOnly,
        expect: { base: entry.base, local: ctx.expectNow(local, entry) },
      }, cur)
    }
    return
  }
  if (ctx.tooLarge(entry, local, cur)) return
  ctx.plan.add(PHASE.content, {
    type: 'upload',
    pageId: copyPage.id,
    operationKey: operationKeyFor('upload', copyPage.id, copyPage.revision, local.contentHash ?? ''),
    relPath: cur,
    kind: entry.kind === 'document' ? 'document' : 'file',
    changeComment: SYNC_COMMENT(ctx.input.computerLabel),
    expect: { base: ctx.headBase(copyPage), local: ctx.expectNow(local, entry) },
  }, cur)
}
