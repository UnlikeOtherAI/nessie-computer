import { isIgnoredPath } from './ignore.js'
import { brakeDeletes } from './plan-brake.js'
import { classifyLocal, classifyRemote, type LocalState } from './reconcile-classify.js'
import { ReconcileContext } from './reconcile-context.js'
import { EntryPlanner, type EntryDecisions, type EntryPlanState } from './reconcile-entries.js'
import { PHASE, type LocalScanItem, type ReconcileInput, type ReconcilePlan } from './reconcile-model.js'
import { planLocalOnly, planRemoteOnly } from './reconcile-untracked.js'
import { firstSegment, isWithin, nameKey, parentPath } from './path-mapping.js'
import type { SyncEntry } from './types.js'

/**
 * The folder sync reconciler (plan §2.6, §3): a pure function from the index
 * entries, a local scan and the server manifest to the actions that bring the
 * two sides together. It performs no I/O; every action carries the base it
 * was planned on, and whoever carries it out re-checks that base and drops
 * the action back to planning on any drift.
 *
 * Nothing is planned without a root (C21: `root_missing` propagates no
 * deletes) or before the first snapshot.
 */
export const reconcile = (input: ReconcileInput): ReconcilePlan => {
  if (!input.local.rootPresent || input.remote.snapshotAt === null) return { actions: [], heldDeletes: null }
  const ctx = new ReconcileContext(input)
  const states = classifyAll(ctx)
  const entries = new Map(input.entries.map((entry) => [entry.pageId, entry]))

  planSpaceRenames(ctx)
  const lostSpaceDirs = planLostSpaces(ctx, states)

  const decisions = decide(ctx, states, entries)
  const settled = new Set<string>()
  const items = new Map(states.map((state) => [state.entry.pageId, state.L?.item ?? null]))
  const planner = new EntryPlanner(ctx, decisions, settled, items)
  // Top-down on both sides: an entry comes after the folders that hold it
  // here and the ones that hold it in Nessie, whose moves decide where it goes.
  const depthOfState = (state: EntryPlanState) => {
    const here = depthOf(state.L?.item?.relPath ?? state.entry.relPath)
    return Math.max(here, state.mapped === null ? here : depthOf(state.mapped))
  }
  const ordered = [...states].sort((a, b) => depthOfState(a) - depthOfState(b))
  for (const state of ordered) planner.planEntry(state)

  planRemoteOnly(ctx, new Set([...entries.keys(), ...decisions.adoptedTwins]))
  planLocalOnly(ctx, lostSpaceDirs)

  const brake = brakeDeletes(decisions.archives, {
    entryCount: input.entries.length,
    missing: missingFolders(ctx, states),
    decision: input.heldDecision,
  })
  for (const action of brake.archives) ctx.plan.add(PHASE.archives, action, action.relPath)
  for (const candidate of brake.held) {
    ctx.plan.add(PHASE.bookkeeping, {
      type: 'holdDelete',
      pageId: candidate.action.pageId,
      relPath: candidate.action.relPath,
      batchId: brake.heldDeletes!.batchId,
    })
  }
  for (const candidate of brake.restore) restoreSubtree(ctx, states, candidate.action.relPath)

  for (const entry of input.entries) {
    if (entry.state !== 'synced' && settled.has(entry.pageId) && !ctx.plan.touches(entry.pageId)) {
      ctx.plan.setState(entry, 'synced', null)
    }
  }
  return { actions: ctx.plan.actions(), heldDeletes: brake.heldDeletes }
}

const depthOf = (path: string) => path.split('/').length

/** L and R for every entry, and the scan items no entry accounts for. */
const classifyAll = (ctx: ReconcileContext): EntryPlanState[] => {
  const { input, local } = ctx
  const tracked = new Set<string>()
  for (const entry of input.entries) {
    const item = local.byPath.get(entry.relPath)
    // A link at an entry's path is that entry's to report (C17), not a new item.
    if (item && (item.type === 'link' || (entry.kind === 'folder') === (item.type === 'directory'))) {
      tracked.add(entry.relPath)
    }
  }
  const movedTo = new Set<string>()
  const isUntracked = (item: LocalScanItem) => !tracked.has(item.relPath) && !movedTo.has(item.relPath)
  // Two entries naming one path (one's file moved away first): the item is the
  // one whose file id it carries; the other must not read it as its own.
  const atPath = new Map<string, SyncEntry[]>()
  for (const entry of input.entries) atPath.set(entry.relPath, [...(atPath.get(entry.relPath) ?? []), entry])
  const heldByOther = (entry: SyncEntry, item: LocalScanItem) => item.fileId !== null
    && item.fileId !== entry.local?.fileId
    && (atPath.get(entry.relPath) ?? []).some((other) => other !== entry && other.local?.fileId === item.fileId)
  // Folders before what they hold: an item whose folder moved is looked for where the folder took it.
  const folderMoves: Array<{ from: string; to: string }> = []
  const carriedTo = (relPath: string): string | null => {
    const move = folderMoves.filter(({ from }) => relPath !== from && isWithin(relPath, from))
      .sort((a, b) => b.from.length - a.from.length)[0]
    return move ? `${move.to}${relPath.slice(move.from.length)}` : null
  }
  const byDepth = [...input.entries].sort((a, b) => depthOf(a.relPath) - depthOf(b.relPath))
  const classified = new Map(byDepth.map((entry): [string, EntryPlanState] => {
    const carried = carriedTo(entry.relPath)
    const L: LocalState | null = classifyLocal(entry, local, input.now, isUntracked, heldByOther, carried)
    // First claim wins: a second entry with the same file id is a delete.
    if (L?.change === 'moved' && L.item) {
      movedTo.add(L.item.relPath)
      if (entry.kind === 'folder') folderMoves.push({ from: entry.relPath, to: L.item.relPath })
    }
    const page = ctx.pages.get(entry.pageId) ?? null
    const mapped = page ? ctx.mapping.paths.get(page.id) ?? null : null
    return [entry.pageId, { entry, L, R: classifyRemote(entry, page, mapped, input.remote), mapped }]
  }))
  const states = input.entries.map((entry) => classified.get(entry.pageId)!)
  for (const item of input.local.items) {
    if (isUntracked(item) && (item.type === 'link' || !isIgnoredPath(item.relPath))) {
      ctx.untracked.set(item.relPath, { item, consumed: false })
    }
  }
  for (const entry of input.entries) ctx.knowSpaceDir(firstSegment(entry.relPath), entry.spaceId)
  for (const [spaceId, dir] of Object.entries(input.spaceDirs ?? {})) ctx.knowSpaceDir(dir, spaceId)
  return states
}

/**
 * A space's directory as this computer last left it, for a space none of
 * whose entries says where it is (it holds nothing tracked): only when the
 * scan walked it and found it.
 */
const emptySpaceDirs = (ctx: ReconcileContext): Array<[spaceId: string, dir: string]> => {
  const tracked = new Set(ctx.input.entries.map((entry) => entry.spaceId))
  return Object.entries(ctx.input.spaceDirs ?? {}).filter(([spaceId, dir]) => !tracked.has(spaceId)
    && ctx.local.inScope(dir) && ctx.local.byPath.get(dir)?.type === 'directory')
}

/** C26: a renamed space renames its directory; everything in it follows. */
const planSpaceRenames = (ctx: ReconcileContext): void => {
  const oldDirs = new Map<string, Map<string, number>>()
  for (const entry of ctx.input.entries) {
    const dirs = oldDirs.get(entry.spaceId) ?? new Map<string, number>()
    const dir = firstSegment(entry.relPath)
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    oldDirs.set(entry.spaceId, dirs)
  }
  for (const [spaceId, dir] of emptySpaceDirs(ctx)) oldDirs.set(spaceId, new Map([[dir, 0]]))
  const pending = new Map<string, { oldDir: string; wanted: string }>()
  for (const [spaceId, dirs] of oldDirs) {
    const wanted = ctx.mapping.spaceDirs.get(spaceId)
    const [oldDir] = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0]!
    if (wanted && oldDir !== wanted) pending.set(spaceId, { oldDir, wanted })
  }
  // A directory this pass did not walk is still renamed whole (its entries say
  // it is there; the move re-checks): moving its files one by one would leave
  // the directory, and anything new in it, behind. A target another space's
  // directory is leaving is free once that move is planned, so renames repeat
  // until none can go.
  const knownDirs = new Set([...ctx.local.byPath.keys(), ...[...oldDirs.values()].flatMap((dirs) => [...dirs.keys()])])
  const taken = (dir: string, leaving: string) => [...knownDirs]
    .some((path) => !path.includes('/') && path !== leaving && nameKey(ctx.current(path)) === nameKey(dir))
  for (let progress = true; progress;) {
    progress = false
    for (const [spaceId, { oldDir, wanted }] of pending) {
      const item = ctx.local.byPath.get(oldDir)
      if (ctx.local.inScope(oldDir) ? item?.type !== 'directory' : false) {
        pending.delete(spaceId)
        continue
      }
      if (taken(wanted, oldDir)) continue
      ctx.plan.add(PHASE.spaceMoves, {
        type: 'moveLocal',
        pageId: null,
        fromRelPath: oldDir,
        toRelPath: wanted,
        expect: { base: null, local: item ? ctx.expectItem(item, null) : { fileId: null, contentHash: null } },
      }, wanted)
      ctx.movedLocally(oldDir, wanted)
      pending.delete(spaceId)
      progress = true
    }
  }
}

/**
 * C14: a space the owner can no longer read leaves the disk. Its directory
 * goes to the trash whole; an edit that never reached Nessie goes with it and
 * is flagged. One info row names the space's directory.
 */
const planLostSpaces = (ctx: ReconcileContext, states: readonly EntryPlanState[]): string[] => {
  const lost = new Map<string, EntryPlanState[]>()
  for (const state of states) {
    if (state.R.change !== 'access_lost') continue
    lost.set(state.entry.spaceId, [...(lost.get(state.entry.spaceId) ?? []), state])
  }
  const dirs: string[] = []
  for (const [spaceId, group] of lost) {
    const dir = ctx.current(firstSegment(group[0]!.entry.relPath))
    // A directory this pass did not walk is not gone: forgetting its entries
    // now would leave the mirror on disk with nothing to remove it later.
    if (!ctx.local.inScope(ctx.raw(dir))) continue
    const dirItem = ctx.local.byPath.get(ctx.raw(dir))
    for (const { entry, L } of group) {
      if (L?.change === 'deleted' || !dirItem) {
        ctx.plan.add(PHASE.bookkeeping, { type: 'forgetEntry', pageId: entry.pageId, relPath: entry.relPath })
      }
      if (L?.contentChanged) {
        ctx.plan.record('access_removed_edit_kept', { pageId: entry.pageId, relPath: entry.relPath }, L.contentHash ?? '')
      }
    }
    if (!dirItem || dirItem.type !== 'directory') continue
    trashSpaceDir(ctx, spaceId, dir, dirItem)
    dirs.push(dir)
  }
  // A lost space that held nothing tracked here still leaves its directory.
  const { spaces, excludedSpaceIds } = ctx.input.remote
  const mirrored = (spaceId: string) => !excludedSpaceIds.includes(spaceId)
    && spaces.some((space) => space.id === spaceId)
  const mappedDirs = new Set([...ctx.mapping.spaceDirs.values()].map((dir) => nameKey(dir)))
  for (const [spaceId, dir] of emptySpaceDirs(ctx)) {
    if (mirrored(spaceId) || mappedDirs.has(nameKey(dir))) continue
    trashSpaceDir(ctx, spaceId, dir, ctx.local.byPath.get(dir)!)
    dirs.push(dir)
  }
  return dirs
}

const trashSpaceDir = (ctx: ReconcileContext, spaceId: string, dir: string, dirItem: LocalScanItem): void => {
  ctx.plan.add(PHASE.vacate, {
    type: 'trashLocal',
    pageId: null,
    relPath: dir,
    expect: { base: null, local: ctx.expectItem(dirItem, null) },
  }, dir)
  ctx.plan.record('access_removed', { pageId: null, relPath: dir }, spaceId)
  for (const { item } of ctx.untracked.values()) {
    if (item.type === 'file' && isWithin(ctx.current(item.relPath), dir)) {
      ctx.plan.record('access_removed_edit_kept', { pageId: null, relPath: ctx.current(item.relPath) }, item.contentHash ?? '')
    }
  }
}

/** An entry's ancestor entries, nearest first. */
const ancestors = (entry: SyncEntry, entries: ReadonlyMap<string, SyncEntry>): SyncEntry[] => {
  const found: SyncEntry[] = []
  let parentId = entry.parentPageId
  while (parentId !== null) {
    const parent = entries.get(parentId)
    if (!parent) break
    found.push(parent)
    parentId = parent.parentPageId
  }
  return found
}

/**
 * The decisions that span entries: which locally deleted folders come back
 * because something inside changed in Nessie (C5a), and which folders deleted
 * in Nessie come back because something inside was edited or added here (C5b).
 */
const decide = (
  ctx: ReconcileContext,
  states: readonly EntryPlanState[],
  entries: ReadonlyMap<string, SyncEntry>,
): EntryDecisions => {
  const byPage = new Map(states.map((state) => [state.entry.pageId, state]))
  const restore = new Set<string>()
  const restoreWithAncestors = (entry: SyncEntry) => {
    restore.add(entry.pageId)
    for (const ancestor of ancestors(entry, entries)) {
      if (byPage.get(ancestor.pageId)?.L?.change !== 'deleted') break
      restore.add(ancestor.pageId)
    }
  }
  for (const { entry, L, R } of states) {
    if (L?.change !== 'deleted' || !R.page) continue
    if (R.contentChanged || R.moved || R.page.readOnly || entry.kind === 'spreadsheet') restoreWithAncestors(entry)
  }
  // A page that arrived in a folder deleted here (new in Nessie, or moved
  // into it there) brings the folder back rather than being archived with it.
  for (const page of ctx.input.remote.pages) {
    if (page.parentPageId === null) continue
    const parent = entries.get(page.parentPageId)
    if (!parent || byPage.get(parent.pageId)?.L?.change !== 'deleted') continue
    const own = entries.get(page.id)
    if (!own || own.parentPageId !== page.parentPageId) restoreWithAncestors(parent)
  }

  const recreate = new Set<string>()
  const keptEntryChild = new Set<string>()
  const recreateFrom = (parentId: string | null, viaEntry: boolean) => {
    while (parentId !== null) {
      const state = byPage.get(parentId)
      if (!state || state.R.change !== 'deleted' || state.L?.change === 'deleted') break
      recreate.add(parentId)
      if (viaEntry) keptEntryChild.add(parentId)
      parentId = state.entry.parentPageId
    }
  }
  const folderAtRaw = new Map<string, EntryPlanState>()
  for (const state of states) {
    if (state.entry.kind === 'folder' && state.L?.item) folderAtRaw.set(nameKey(state.L.item.relPath), state)
  }
  // The folders around where an item is now: deleted in Nessie, they come back with it.
  const recreateAround = (relPath: string, viaEntry: boolean) => {
    for (let dir = parentPath(relPath); dir !== ''; dir = parentPath(dir)) {
      const folder = folderAtRaw.get(nameKey(dir))
      if (!folder) continue
      if (folder.R.change === 'deleted') recreateFrom(folder.entry.pageId, viaEntry)
      break
    }
  }
  for (const { entry, L, R } of states) {
    // Only once the kept child is settled: the folder and the child are then
    // recreated in one pass, and the row says why (C5b). Until then the folder
    // is kept whole and waits with it. A child a person moved counts where it
    // is now, not where its page last was.
    if (!L || !L.stable || L.needsHash) continue
    if (L.change === 'moved' && L.item) recreateAround(L.item.relPath, true)
    else if (R.change === 'deleted' && L.change !== 'deleted' && L.contentChanged) recreateFrom(entry.parentPageId, true)
  }
  for (const { item, consumed } of ctx.untracked.values()) {
    if (!consumed && item.type !== 'link') recreateAround(item.relPath, false)
  }
  const keepWhole = new Set<string>()
  for (const state of states) {
    if (state.entry.kind !== 'folder' || state.R.change !== 'deleted' || !state.L?.item) continue
    const dir = state.L.item.relPath
    const blocked = states.some((other) => (
      other !== state && other.L?.item && isWithin(other.L.item.relPath, dir)
      && (other.R.change !== 'deleted' || other.L.contentChanged || other.L.change === 'moved')
    ))
    if (blocked) keepWhole.add(state.entry.pageId)
  }
  return {
    restore,
    recreate,
    recreateRowOnFolder: new Set([...recreate].filter((id) => !keptEntryChild.has(id))),
    keepWhole,
    archivedFolders: [],
    trashedFolders: [],
    archives: [],
    adoptedTwins: [],
  }
}

/**
 * C23: deletes here whose space or team folder vanished as a whole are held,
 * however few — a missing space directory is far more likely a moved or
 * unmounted folder than an intent to delete a space.
 */
const missingFolders = (
  ctx: ReconcileContext,
  states: readonly EntryPlanState[],
): 'team_folder_missing' | 'space_folder_missing' | null => {
  if (ctx.input.entries.length === 0) return null
  if (!ctx.input.local.teamFolderPresent) return 'team_folder_missing'
  for (const state of states) {
    if (state.R.change === 'access_lost') continue
    const dir = firstSegment(state.entry.relPath)
    if (!ctx.local.inScope(dir)) continue
    const wanted = ctx.mapping.spaceDirs.get(state.entry.spaceId)
    if (!ctx.local.byPath.has(dir) && !(wanted && ctx.local.byPath.has(wanted))) return 'space_folder_missing'
  }
  return null
}

/** The person chose Restore for held deletes: everything under each held root comes back. */
const restoreSubtree = (ctx: ReconcileContext, states: readonly EntryPlanState[], root: string): void => {
  const subtree = states
    .filter((state) => isWithin(state.entry.relPath, root) && state.L?.change === 'deleted' && state.R.page && state.mapped)
    .sort((a, b) => depthOf(a.entry.relPath) - depthOf(b.entry.relPath))
  for (const { entry, R, mapped } of subtree) {
    const want = ctx.wanted(mapped!)
    if (ctx.claim(R.page!, want) === 'wait') continue
    ctx.materialize(R.page!, want, entry.kind === 'folder' ? null : entry.base)
  }
}
