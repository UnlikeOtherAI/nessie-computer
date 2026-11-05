import { localUnchanged, type LocalState } from './reconcile-classify.js'
import type { ReconcileContext } from './reconcile-context.js'
import type { EntryDecisions } from './reconcile-entries.js'
import { PHASE, type LocalScanItem } from './reconcile-model.js'
import { firstSegment, idTag, nameKey, parentPath } from './path-mapping.js'
import type { ReconcileAction, SyncEntry } from './types.js'

const below = (path: string, ancestor: string): boolean => nameKey(path).startsWith(`${nameKey(ancestor)}/`)
type MoveExpect = Extract<ReconcileAction, { type: 'moveLocal' }>['expect']

/** Physical path ownership and crash-safe parking for tracked local moves. */
export class LocalMovePlanner {
  constructor(
    private readonly ctx: ReconcileContext,
    private readonly decisions: Pick<EntryDecisions, 'recreate' | 'keepWhole'>,
    private readonly items: ReadonlyMap<string, LocalScanItem | null>,
  ) {}

  private get planBuilder() { return this.ctx.plan }

  /**
   * Move a tracked file to where Nessie now maps it. A path another tracked
   * file still holds is never overwritten: when that file is about to take
   * this one's place (a cycle of names in Nessie), all go through a hidden
   * parking name first; otherwise this one waits a pass for the holder to
   * move. The executor's journal completes a parked move after a crash.
   */
  plan(entry: SyncEntry, cur: string, want: string, local: LocalState): string {
    // Nessie put this folder inside one that is inside it here (a nesting
    // inversion): that one lifts it into place (`liftOutOf`); until then it waits.
    const newParent = this.ctx.pages.get(entry.pageId)!.parentPageId
    const parentItem = newParent === null ? null : this.items.get(newParent) ?? null
    if (parentItem && below(this.ctx.current(parentItem.relPath), cur)) return cur
    if (this.ctx.claim(this.ctx.pages.get(entry.pageId)!, want, false) === 'wait') return cur
    const expect = { base: entry.base, local: this.ctx.expectNow(local, entry) }
    const holderPath = this.ctx.raw(want)
    // Exact paths: an NFD name and its NFC twin are two files, though one name key.
    // The holder is the entry at that path, or the one whose item was moved there (by its file id).
    // On a case-insensitive disk an item named like `want` in another case holds it too.
    const own = local.item?.relPath ?? entry.relPath
    const held = this.ctx.local.byPath.get(holderPath) ?? [...this.ctx.local.byPath.values()]
      .find((item) => item.relPath !== own && item.relPath.toLowerCase() === holderPath.toLowerCase())
    const holder = held && held.relPath !== own
      ? this.ctx.input.entries.find((other) => other.pageId !== entry.pageId && (other.relPath === holderPath
        || (held.fileId !== null && other.local?.fileId === held.fileId)))
      : undefined
    let from = cur
    const holderMapped = holder ? this.ctx.mapping.paths.get(holder.pageId) : undefined
    // A holder whose page is gone is trashed before any local move runs,
    // unless an edit keeps it there as a new page (C2, C5b): then wait a pass.
    if (holder && !holderMapped && this.keptInPlace(holder)) return cur
    if (holder && holderMapped && held && this.ctx.pages.get(holder.pageId)?.parentPageId === entry.pageId) {
      return this.liftOutOf(entry, cur, want, expect, holder, held, holderMapped)
    }
    // Into a path below its own name ("DOCS" into "Docs/DOCS" on a disk that ignores case): park it first.
    const intoItself = want.toLowerCase().startsWith(`${cur.toLowerCase()}/`)
    if ((holder && holderMapped) || intoItself) {
      if (!intoItself) {
        const cycle = this.moveCycle(entry, holder!)
        if (!cycle) return cur
        if (cycle.length > 2) {
          for (const member of cycle.filter((page) => page.kind === 'folder')) {
            this.ctx.deferCycleFolder(this.items.get(member.pageId)?.relPath ?? member.relPath)
            this.ctx.deferCycleFolder(this.ctx.mapping.paths.get(member.pageId)!)
          }
        }
      }
      from = `${parentPath(cur)}/.nessie-sync-move-${idTag(entry.pageId)}`
      this.planBuilder.add(PHASE.vacate, { type: 'moveLocal', pageId: entry.pageId, fromRelPath: cur, toRelPath: from, expect }, cur)
    }
    this.planBuilder.add(PHASE.localMoves, { type: 'moveLocal', pageId: entry.pageId, fromRelPath: from, toRelPath: want, expect }, want)
    this.ctx.movedLocally(cur, want)
    return want
  }

  /** Follow physical holders to distinguish a closed rename cycle from a path still in use. */
  private moveCycle(entry: SyncEntry, holder: SyncEntry): SyncEntry[] | null {
    const cycle = [entry]
    const seen = new Set([entry.pageId])
    let next: SyncEntry | undefined = holder
    while (next && next.pageId !== entry.pageId) {
      if (seen.has(next.pageId)) return null
      seen.add(next.pageId)
      cycle.push(next)
      const mapped = this.ctx.mapping.paths.get(next.pageId)
      if (!mapped) return null
      const target = this.ctx.wanted(mapped)
      const targetSpace = this.ctx.spaceOfDir(firstSegment(target))
      const tail = (path: string) => nameKey(path.slice(path.indexOf('/')))
      next = this.ctx.input.entries.find((candidate) => {
        const path = this.items.get(candidate.pageId)?.relPath
        return path !== undefined && this.ctx.spaceOfDir(firstSegment(path)) === targetSpace
          && tail(path) === tail(target)
      })
    }
    return next ? cycle : null
  }

  /**
   * A parent takes its child's old path, either a nesting inversion or two
   * separately placed folders. In Nessie `holder` now sits inside it. The
   * holder is parked beside where it is, this folder leaves it for its own
   * place, then the holder goes inside. The runner journals all three legs
   * before the first runs, so a crash finishes them.
   */
  private liftOutOf(
    entry: SyncEntry, cur: string, want: string, expect: MoveExpect,
    holder: SyncEntry, held: LocalScanItem, holderMapped: string,
  ): string {
    const holderCur = this.ctx.current(held.relPath)
    const park = `${parentPath(holderCur)}/.nessie-sync-move-${idTag(holder.pageId)}`
    const holderWant = this.ctx.wanted(holderMapped)
    const holderExpect = { base: holder.base, local: this.ctx.expectItem(held, null) }
    const step = (pageId: string, fromRelPath: string, toRelPath: string, moveExpect: MoveExpect) =>
      ({ type: 'moveLocal' as const, pageId, fromRelPath, toRelPath, expect: moveExpect })
    this.planBuilder.add(PHASE.vacate, step(holder.pageId, holderCur, park, holderExpect), holderCur)
    const from = below(cur, holderCur) ? `${park}${cur.slice(holderCur.length)}` : cur
    this.planBuilder.add(PHASE.localMoves, step(entry.pageId, from, want, expect), want)
    this.planBuilder.add(PHASE.localMoves, step(holder.pageId, park, holderWant, holderExpect), holderWant)
    this.ctx.movedLocally(holderCur, park)
    this.ctx.movedLocally(from, want)
    this.ctx.movedLocally(park, holderWant)
    return want
  }

  /** A tracked item whose page is gone that stays where it is (recreated), rather than going to the trash. */
  private keptInPlace(holder: SyncEntry): boolean {
    if (holder.kind === 'folder') return this.decisions.recreate.has(holder.pageId) || this.decisions.keepWhole.has(holder.pageId)
    const item = this.ctx.local.byPath.get(holder.relPath)
    const hash = item?.contentHash ?? (item && localUnchanged(holder.local, item) ? holder.local!.contentHash : null)
    return hash === null || hash !== holder.base.contentHash
  }

}
