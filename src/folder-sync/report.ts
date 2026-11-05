import {
  FOLDER_SYNC_CONSOLE_LIST_LIMIT,
  FOLDER_SYNC_REPORT_LIMITS,
  folderSyncCountsAreSettled,
  type ConflictReport,
  type FolderSyncConflictResolution,
  type FolderSyncCounts,
  type FolderSyncEngineState,
  type FolderSyncHeartbeatSummary,
  type FolderSyncHeldDeletes,
  type FolderSyncRecordStatus,
  type FolderSyncReportRequest,
} from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import { readStateJson, writeStateJson } from './state-files.js'
import type { SyncEntry } from './types.js'

/**
 * What folder sync tells people (R7, A12.12): the conflict rows, the counts
 * and the one engine state the console, the heartbeat and the report share.
 * `up_to_date` is only ever derived from counts (`folderSyncCountsAreSettled`),
 * never from a request having succeeded.
 */

export type ConflictRowState = 'open' | 'resolving' | 'resolved'

export type ConflictRow = {
  report: ConflictReport
  state: ConflictRowState
  /** Sent in a report since its last change. */
  reported: boolean
  resolution: FolderSyncConflictResolution | null
  /** The resolution was sent in a report. */
  resolutionReported: boolean
}

type ConflictBookFile = { version: 1; rows: ConflictRow[] }

/** Resolved rows kept after their resolution was reported, newest first. */
const RESOLVED_KEPT = 500

/**
 * `conflicts.json`: every row this computer has raised, what was reported and
 * what was resolved. The console lists the open ones; the report sends the
 * unreported ones and the resolutions.
 */
export class ConflictBook {
  private constructor(
    private readonly path: string,
    private rows: ConflictRow[],
    private readonly security: StateSecurityDeps,
  ) {}

  static async open(path: string, security: StateSecurityDeps = {}): Promise<ConflictBook> {
    const file = await readStateJson<ConflictBookFile>(path, { version: 1, rows: [] })
    return new ConflictBook(path, file.rows, security)
  }

  private async save(): Promise<void> {
    const settled = this.rows.filter((row) => row.state === 'resolved' && row.resolutionReported)
    const keep = new Set(settled.slice(-RESOLVED_KEPT).map((row) => row.report.clientConflictId))
    this.rows = this.rows.filter((row) => !(row.state === 'resolved' && row.resolutionReported)
      || keep.has(row.report.clientConflictId))
    await writeStateJson(this.path, { version: 1, rows: this.rows } satisfies ConflictBookFile, this.security)
  }

  has(clientConflictId: string): boolean {
    return this.rows.some((row) => row.report.clientConflictId === clientConflictId)
  }

  get(clientConflictId: string): ConflictRow | undefined {
    return this.rows.find((row) => row.report.clientConflictId === clientConflictId)
  }

  /** Raise rows (R7: a row already raised is never raised again). */
  async add(reports: readonly ConflictReport[]): Promise<void> {
    const fresh = reports.filter((report) => !this.has(report.clientConflictId))
    if (fresh.length === 0) return
    for (const report of fresh) {
      this.rows.push({ report, state: 'open', reported: false, resolution: null, resolutionReported: false })
    }
    await this.save()
  }

  /** A row changed under a person's decision (C32): it is open again, with a new `occurredAt`. */
  async reopen(clientConflictId: string, report: ConflictReport): Promise<void> {
    const row = this.get(clientConflictId)
    if (!row) return
    row.report = report
    row.state = 'open'
    row.reported = false
    await this.save()
  }

  async resolve(clientConflictId: string, resolution: FolderSyncConflictResolution): Promise<void> {
    const row = this.get(clientConflictId)
    if (!row || row.state === 'resolved') return
    row.state = 'resolved'
    row.resolution = resolution
    row.resolutionReported = false
    await this.save()
  }

  /** Open rows, newest first. */
  open(): ConflictRow[] {
    return this.rows.filter((row) => row.state !== 'resolved').reverse()
  }

  /** Rows that keep the engine from `up_to_date`: info rows are told, not waited on. */
  openNeedingAttention(): number {
    return this.rows.filter((row) => row.state !== 'resolved' && row.report.kind !== 'info').length
  }

  /** What the next report carries. */
  outbox(): Pick<FolderSyncReportRequest, 'conflicts' | 'resolved'> {
    return {
      conflicts: this.rows.filter((row) => !row.reported).slice(0, FOLDER_SYNC_REPORT_LIMITS.conflicts)
        .map((row) => row.report),
      resolved: this.rows.filter((row) => row.state === 'resolved' && !row.resolutionReported && row.resolution)
        .slice(0, FOLDER_SYNC_REPORT_LIMITS.resolved)
        .map((row) => ({ clientConflictId: row.report.clientConflictId, resolution: row.resolution! })),
    }
  }

  /** The server took the report: mark what it carried. */
  async delivered(outbox: Pick<FolderSyncReportRequest, 'conflicts' | 'resolved'>): Promise<void> {
    const sent = new Set(outbox.conflicts.map((report) => `${report.clientConflictId}@${report.occurredAt}`))
    const resolved = new Set(outbox.resolved.map((item) => item.clientConflictId))
    let changed = false
    for (const row of this.rows) {
      if (!row.reported && sent.has(`${row.report.clientConflictId}@${row.report.occurredAt}`)) {
        row.reported = true
        changed = true
      }
      if (row.state === 'resolved' && !row.resolutionReported && resolved.has(row.report.clientConflictId)) {
        row.resolutionReported = true
        changed = true
      }
    }
    if (changed) await this.save()
  }

  /** The console's list: open rows, newest first, bounded. */
  consoleRows(): ConflictReport[] {
    return this.open().slice(0, FOLDER_SYNC_CONSOLE_LIST_LIMIT).map((row) => row.report)
  }
}

/** What a pass leaves to do, counted from the plan it could not finish. */
export type PassRemainder = { uploads: number; downloads: number }

export const countEntries = (
  entries: readonly SyncEntry[],
  remainder: PassRemainder,
  openConflicts: number,
  heldDeletes: FolderSyncHeldDeletes | null,
  notSynced: number,
): FolderSyncCounts => ({
  entries: entries.length,
  pendingUploads: remainder.uploads,
  pendingDownloads: remainder.downloads,
  openConflicts,
  waiting: entries.filter((entry) => entry.state === 'waiting').length,
  errors: entries.filter((entry) => entry.state === 'error').length,
  heldDeletes: heldDeletes?.count ?? 0,
  notSynced,
})

/** The facts the engine state is decided from, most decisive first. */
export type EngineFacts = {
  enabled: boolean
  paused: boolean
  serverStatus: FolderSyncRecordStatus | 'not_private' | null
  rootPresent: boolean
  diskFull: boolean
  offline: boolean
  snapshotTaken: boolean
  counts: FolderSyncCounts
}

export const engineStateOf = (facts: EngineFacts): FolderSyncEngineState => {
  if (!facts.enabled) return 'off'
  if (facts.serverStatus === 'not_private') return 'not_private'
  if (facts.serverStatus === 'disabled') return 'off'
  if (facts.paused || facts.serverStatus === 'paused') return 'paused'
  if (facts.serverStatus === 'needs_reauthorization') return 'needs_reauthorization'
  if (facts.serverStatus === 'requested') return 'waiting_for_confirmation'
  if (facts.offline && facts.serverStatus === null) return 'offline'
  if (!facts.rootPresent) return 'root_missing'
  if (facts.diskFull) return 'disk_full'
  if (facts.offline) return 'offline'
  if (!facts.snapshotTaken || facts.serverStatus === null) return 'starting'
  if (folderSyncCountsAreSettled(facts.counts)) return 'up_to_date'
  const pending = facts.counts.pendingUploads + facts.counts.pendingDownloads + facts.counts.waiting
  return pending === 0 ? 'needs_attention' : 'syncing'
}

export const heartbeatSummaryOf = (
  enabled: boolean,
  state: FolderSyncEngineState,
  counts: FolderSyncCounts,
  lastReconcileAt: string | null,
): FolderSyncHeartbeatSummary => ({
  requested: enabled,
  state,
  pending: counts.pendingUploads + counts.pendingDownloads + counts.waiting,
  openConflicts: counts.openConflicts,
  heldDeletes: counts.heldDeletes,
  lastReconcileAt,
})
