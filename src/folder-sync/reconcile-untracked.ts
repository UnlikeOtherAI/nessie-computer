import { FOLDER_SYNC_TIMING, type SyncPage } from '@nessie/executor-protocol'

import { PHASE, pageKeyFor, type LocalScanItem } from './reconcile-model.js'
import type { ReconcileContext } from './reconcile-context.js'
import { baseName, isWithin, parentPath, titleForLocalName } from './path-mapping.js'

/**
 * What only one side has: pages Nessie has that no entry tracks yet (R
 * created: download, or C6/C7 when a local item is already at the path) and
 * local items no entry tracks (L created: a new page).
 */

const depth = (path: string) => path.split('/').length

/** The path a report can name for an unmappable page: its nearest mapped ancestor, or its space. */
const nearestMappedPath = (ctx: ReconcileContext, page: SyncPage): string | null => {
  let parentId = page.parentPageId
  while (parentId !== null) {
    const path = ctx.mapping.paths.get(parentId)
    if (path) return path
    parentId = ctx.pages.get(parentId)?.parentPageId ?? null
  }
  return ctx.mapping.spaceDirs.get(page.spaceId) ?? null
}

/** Pages with no entry, parents first. */
export const planRemoteOnly = (ctx: ReconcileContext, tracked: ReadonlySet<string>): void => {
  const pages = ctx.input.remote.pages
    .filter((page) => !tracked.has(page.id))
    .map((page) => ({ page, mapped: ctx.mapping.paths.get(page.id) ?? null }))
    .sort((a, b) => depth(a.mapped ?? '') - depth(b.mapped ?? ''))
  for (const { page, mapped } of pages) {
    if (mapped === null) {
      const near = nearestMappedPath(ctx, page)
      if (near !== null && ctx.mapping.unmappable.get(page.id) === 'path_too_long') {
        ctx.plan.record('name_not_supported', { pageId: page.id, relPath: near }, page.id)
      }
      continue
    }
    if (page.kind !== 'folder' && page.head === null) continue
    const want = ctx.wanted(mapped)
    if (ctx.belowMovingCycle(want)) continue
    // A page lands only inside its own parent folder: writing it while the
    // parent waits would make that directory on disk for whoever holds the path.
    if (!ctx.parentPlaced(page, want)) continue
    const claimed = ctx.claim(page, want)
    if (claimed !== 'cleared') continue
    ctx.materialize(page, want, null)
    if (page.kind === 'folder') {
      ctx.registerFolder(ctx.raw(want), { spaceId: page.spaceId, parent: { type: 'existing', pageId: page.id } })
    }
  }
}

/** Local items with no entry, parents first: each becomes a new page, unless it cannot. */
export const planLocalOnly = (ctx: ReconcileContext, lostSpaceDirs: readonly string[]): void => {
  const items = [...ctx.untracked.values()]
    .filter((candidate) => !candidate.consumed)
    .map(({ item }) => ({ item, cur: ctx.current(item.relPath) }))
    .sort((a, b) => depth(a.cur) - depth(b.cur))
  for (const { item, cur } of items) {
    if (ctx.belowMovingCycle(item.relPath)) continue
    if (lostSpaceDirs.some((dir) => isWithin(cur, dir))) continue
    if (ctx.spaceOfDir(cur) !== null && !cur.includes('/')) continue
    planLocalItem(ctx, item, cur)
  }
}

const planLocalItem = (ctx: ReconcileContext, item: LocalScanItem, cur: string): void => {
  const subject = { pageId: null, relPath: cur }
  if (item.type === 'link') {
    ctx.plan.record('link_not_synced', subject, 'link')
    return
  }
  if (!ctx.stable(item)) {
    const since = item.unopenableSinceMs
    if (since !== null && ctx.input.now - since >= FOLDER_SYNC_TIMING.waitingReportedAfterMs) {
      ctx.plan.record('file_in_use', subject, String(since))
    }
    return
  }
  const discriminator = item.contentHash ?? 'directory'
  const resolved = ctx.parentFor(parentPath(cur))
  const kind = item.type === 'directory' ? 'folder' : 'file'
  const title = titleForLocalName(baseName(cur), kind)
  if (!resolved || title === null) {
    ctx.plan.record('name_not_supported', subject, discriminator)
    return
  }
  if (!ctx.writableSpace(resolved.spaceId)) {
    // R1 for something new: it stays on disk and is never sent.
    ctx.plan.record('read_only_no_write_access', subject, discriminator, { relPath: cur, pageId: null })
    return
  }
  if (item.type === 'file' && item.size > ctx.input.maxUploadBytes) {
    ctx.plan.record('too_large', subject, discriminator)
    return
  }
  const pageKey = pageKeyFor(ctx.input.passId, cur)
  ctx.plan.add(PHASE.creates, {
    type: 'createRemote',
    pageKey,
    relPath: cur,
    kind,
    spaceId: resolved.spaceId,
    parent: resolved.parent,
    title,
    expect: { base: null, local: ctx.expectItem(item) },
  }, cur)
  if (kind === 'folder') {
    ctx.registerFolder(item.relPath, { spaceId: resolved.spaceId, parent: { type: 'pending', pageKey } })
  }
}
