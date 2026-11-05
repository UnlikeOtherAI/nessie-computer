import { createHash } from 'node:crypto'

import {
  FOLDER_SYNC_CONFLICT_REASON_KIND,
  FOLDER_SYNC_PATH_LIMITS,
  type FolderSyncHeldDeletes,
  type SyncPage,
  type SyncSpace,
} from '@nessie/executor-protocol'

import { QUARANTINE_MARKER } from './ignore.js'
import { cleanSegment, nameKey, parentPath, splitExtension, utf8Bytes } from './path-mapping.js'
import type {
  ConflictCopyAction,
  ConflictReport,
  FolderSyncConflictReason,
  ReconcileAction,
  SyncEntry,
} from './types.js'

/**
 * The reconciler's inputs and outputs, and the small pure helpers every part
 * of the plan shares: deterministic ids, conflict-copy names, and the plan
 * builder that keeps actions in a safe order.
 */

/** One item of a scan, as `lstat` and the hasher saw it. Links are never followed. */
export type LocalScanItem = {
  relPath: string
  type: 'file' | 'directory' | 'link'
  fileId: string | null
  size: number
  mtimeMs: number
  /**
   * The SHA-256 of a file's bytes. The scanner may leave it null when the
   * size, mtime and file id equal the entry's last scan (`localUnchanged`);
   * any other file needs it, or the reconciler waits.
   */
  contentHash: string | null
  /** When the scanner first saw this exact (size, mtime, file id). */
  stableSinceMs: number
  /** When opening it for shared read first failed; null while it opens. */
  unopenableSinceMs: number | null
}

export type LocalScan = {
  /** The root exists and its `.nessie-sync` marker names this sync. False is `root_missing` (C21). */
  rootPresent: boolean
  /** The team's folder under the root exists. */
  teamFolderPresent: boolean
  /** The subtrees walked (team-folder-relative); null for the whole team folder. */
  scope: readonly string[] | null
  items: readonly LocalScanItem[]
}

/**
 * The server's truth as the engine last assembled it from a snapshot and the
 * changes after it (`reconcile-manifest.ts`). `snapshotAt` null means no
 * snapshot was ever taken, and nothing is planned without one.
 */
export type RemoteManifest = {
  snapshotAt: string | null
  spaces: readonly SyncSpace[]
  excludedSpaceIds: readonly string[]
  pages: readonly SyncPage[]
}

export type HeldDeleteDecision = { batchId: string; decision: 'confirm' | 'restore' }

export type ReconcileInput = {
  now: number
  /** A fresh UUID per pass: page creation keys are derived from it. */
  passId: string
  /** Shown in conflicted-copy names. */
  computerLabel: string
  /** Minutes east of UTC, for the stamp in copy names (`-new Date().getTimezoneOffset()`). */
  utcOffsetMinutes: number
  /** The handshake's `limits.maxUploadBytes`. */
  maxUploadBytes: number
  entries: readonly SyncEntry[]
  local: LocalScan
  remote: RemoteManifest
  /** Every conflict id already reported (open or resolved): R7 tells each once. */
  knownConflictIds: ReadonlySet<string>
  /** Pages whose base text the base store holds for their current base (A7); only these merge. */
  mergeBases: ReadonlySet<string>
  /** The person's answer to the held deletes, relayed by the report. */
  heldDecision: HeldDeleteDecision | null
  /** Space id → the directory that last held it here (renamed or removed even with no entries in it). */
  spaceDirs?: Readonly<Record<string, string>>
}

export type ReconcilePlan = {
  actions: ReconcileAction[]
  /** What the brake holds this pass, for the report; null when nothing is held. */
  heldDeletes: FolderSyncHeldDeletes | null
}

// ── Ids ─────────────────────────────────────────────────────────────────────

/**
 * A UUID (version 8, RFC 9562) derived from its parts, so planning the same
 * situation twice gives the same id: a re-planned conflict upserts its row
 * instead of adding one, and a held batch keeps its id while it is unchanged.
 */
export const stableId = (...parts: readonly string[]): string => {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The creation key of a page this pass creates at `relPath`; children name it as their pending parent. */
export const pageKeyFor = (passId: string, relPath: string): string => stableId('page', passId, nameKey(relPath))

/**
 * A write's receipt key (A2): the same write — same page, same base revision,
 * same content or target — always gets the same key, whether it is retried
 * from the journal or planned again, so a lost response replays its receipt.
 */
export const operationKeyFor = (
  operation: 'upload' | 'move' | 'archive' | 'merge',
  pageId: string,
  baseRevision: number,
  ...target: readonly string[]
): string => stableId('operation', operation, pageId, String(baseRevision), ...target)

/**
 * The upload session key: one upload per (page or path, content, write). A
 * retry of the same bytes resumes; new bytes start a new session (plan §2.7).
 * A new version names its operation key: a session's intent carries the base
 * revision, so a write replanned at a new revision must not resume the old
 * session, whose completion would answer the old revision's 409 forever.
 * A new page names its page key for the same reason: its intent carries the
 * parent and title it was planned with, and a create replanned under another
 * parent is another upload (the server refuses a session key reused for it).
 */
export const uploadSessionKey = (
  target: { pageId: string } | { relPath: string }, contentHash: string, writeKey?: string,
): string => stableId('upload', 'pageId' in target ? target.pageId : nameKey(target.relPath), contentHash,
  ...(writeKey ? [writeKey] : []))

// ── Conflict rows and copy names ────────────────────────────────────────────

/** `yyyy-mm-dd HHmm` in the computer's offset. */
export const formatStamp = (now: number, utcOffsetMinutes: number): string => {
  const date = new Date(now + utcOffsetMinutes * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
}

const withinSegment = (stem: string, marker: string, ext: string): string => {
  const budget = FOLDER_SYNC_PATH_LIMITS.segmentBytes - utf8Bytes(marker) - utf8Bytes(ext)
  let kept = ''
  for (const codePoint of stem) {
    if (utf8Bytes(kept + codePoint) > budget) break
    kept += codePoint
  }
  return `${kept}${marker}${ext}`
}

/** A computer's label keeps at most this much of a copy name, so the file's own name survives. */
const COPY_LABEL_BYTES = 64

/** R2: `<name> (conflicted copy – <computer> – <yyyy-mm-dd HHmm>).<ext>`. */
export const conflictedCopyName = (name: string, computerLabel: string, stamp: string): string => {
  const { stem, ext } = splitExtension(name)
  let label = ''
  for (const codePoint of cleanSegment(computerLabel)) {
    if (utf8Bytes(label + codePoint) > COPY_LABEL_BYTES) break
    label += codePoint
  }
  return withinSegment(stem, ` (conflicted copy – ${label.trimEnd()} – ${stamp})`, ext)
}

/** R1: `<name> (your edit – not synced – <yyyy-mm-dd HHmm>).<ext>`; `ignore.ts` keeps it local. */
export const quarantineCopyName = (name: string, stamp: string): string => {
  const { stem, ext } = splitExtension(name)
  return withinSegment(stem, `${QUARANTINE_MARKER}${stamp})`, ext)
}

/** ` (2)`, ` (3)`, … before the extension until no occupied path holds the name. */
export const freePath = (relPath: string, occupied: ReadonlySet<string>): string => {
  if (!occupied.has(nameKey(relPath))) return relPath
  const dir = parentPath(relPath)
  const { stem, ext } = splitExtension(relPath.slice(dir === '' ? 0 : dir.length + 1))
  for (let n = 2; ; n += 1) {
    const name = `${stem} (${n})${ext}`
    const candidate = dir === '' ? name : `${dir}/${name}`
    if (!occupied.has(nameKey(candidate))) return candidate
  }
}

/** The id of the row a conflict copy or quarantine stands for; stable for one situation. */
export const conflictIdFor = (
  reason: FolderSyncConflictReason,
  subject: { pageId: string | null; relPath: string },
  discriminator: string,
): string => stableId('conflict', reason, subject.pageId ?? '', nameKey(subject.relPath), discriminator)

/**
 * The row an executed `conflictCopy` or `quarantine` leaves (R7). Whoever
 * carries the action out records it — only then does the copy exist, which is
 * what keeps a merge that came out clean from reporting a conflict.
 */
export const conflictReportForCopy = (
  action: ConflictCopyAction | Extract<ReconcileAction, { type: 'quarantine' }>,
  occurredAt: string,
): ConflictReport => ({
  clientConflictId: conflictIdFor(action.reason, action, action.copyRelPath),
  kind: FOLDER_SYNC_CONFLICT_REASON_KIND[action.reason],
  reason: action.reason,
  relPath: action.relPath,
  pageId: action.pageId,
  copy: { relPath: action.copyRelPath, pageId: null },
  occurredAt,
})

// ── The plan builder ────────────────────────────────────────────────────────

/**
 * The order a plan runs in. Space renames first; then everything that frees a
 * path (trash, conflict copies, quarantines, items moved aside); then local
 * renames; then downloads into the freed paths; then server writes — creates
 * first, parents before children (a moved page may name a new folder as its
 * parent), moves before archives (a page leaves a folder before the folder
 * goes), then content; merge follow-ups after their merge; bookkeeping last.
 */
export const PHASE = {
  spaceMoves: 0,
  vacate: 1,
  localMoves: 2,
  materialize: 3,
  creates: 4,
  remoteMoves: 5,
  archives: 6,
  content: 7,
  mergeFollowUps: 8,
  bookkeeping: 9,
} as const
export type Phase = (typeof PHASE)[keyof typeof PHASE]

type Planned = { phase: Phase; depth: number; seq: number; action: ReconcileAction }

const depthOf = (relPath: string): number => relPath.split('/').length

export class PlanBuilder {
  private readonly planned: Planned[] = []
  private readonly recorded = new Set<string>()
  private readonly stateSet = new Set<string>()

  constructor(private readonly input: ReconcileInput) {}

  add(phase: Phase, action: ReconcileAction, relPath = ''): void {
    this.planned.push({ phase, depth: relPath === '' ? 0 : depthOf(relPath), seq: this.planned.length, action })
  }

  /** R7: one row per situation, never one the person was already told about. */
  record(
    reason: FolderSyncConflictReason,
    subject: { pageId: string | null; relPath: string },
    discriminator: string,
    copy: { relPath: string; pageId: string | null } | null = null,
  ): void {
    const clientConflictId = conflictIdFor(reason, subject, discriminator)
    if (this.input.knownConflictIds.has(clientConflictId) || this.recorded.has(clientConflictId)) return
    this.recorded.add(clientConflictId)
    this.add(PHASE.bookkeeping, {
      type: 'recordConflict',
      conflict: {
        clientConflictId,
        kind: FOLDER_SYNC_CONFLICT_REASON_KIND[reason],
        reason,
        relPath: subject.relPath,
        pageId: subject.pageId,
        copy,
        occurredAt: new Date(this.input.now).toISOString(),
      },
    })
  }

  /** Set an entry's no-I/O state, only when it changes. */
  setState(entry: SyncEntry, state: SyncEntry['state'], detail: SyncEntry['detail'] | null): void {
    if (this.stateSet.has(entry.pageId)) return
    const sameDetail = (entry.detail?.code ?? null) === (detail?.code ?? null)
    if (entry.state === state && sameDetail) return
    this.stateSet.add(entry.pageId)
    this.add(PHASE.bookkeeping, { type: 'setEntryState', pageId: entry.pageId, state, detail: detail ?? null })
  }

  /** True when an action other than bookkeeping touches this page. */
  touches(pageId: string): boolean {
    return this.planned.some(({ action }) => (
      action.type !== 'recordConflict' && action.type !== 'setEntryState' && 'pageId' in action && action.pageId === pageId
    ))
  }

  actions(): ReconcileAction[] {
    return [...this.planned]
      .sort((a, b) => a.phase - b.phase || a.depth - b.depth || a.seq - b.seq)
      .map(({ action }) => action)
  }
}
