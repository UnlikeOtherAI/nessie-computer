import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  EXECUTOR_FOLDER_SYNC_ERROR_CODES as CODES,
  FOLDER_SYNC_CONCURRENCY,
  FOLDER_SYNC_MAX_FILE_BYTES,
  FOLDER_SYNC_STABLE_MS,
  FOLDER_SYNC_TIMING,
  type FolderSyncHandshakeResponse,
  type FolderSyncHeartbeatSummary,
  type FolderSyncRecordStatus,
} from '@nessie/executor-protocol'

import type { StateSecurityDeps } from '../state-security.js'
import {
  folderSyncRootLabel,
  loadFolderSyncConfig,
  switchFolderSyncOffHere,
  type FolderSyncConfig,
} from './config.js'
import { EMPTY_COUNTS, notSyncedItems, readStatusFile, writeStatusFile, type FolderSyncStatusFile } from './console-state.js'
import { refreshedEntries, spaceDirsNow } from './engine-entries.js'
import {
  ensureTeamFolder, folderIndexOwner, openFolderStore, resetFolderIndex, syncRootPresent,
} from './engine-folder.js'
import { foldChanges, hasNews, manifestWith, pullRemote } from './engine-pull.js'
import { applyResolution } from './engine-resolve.js'
import { StopPassError, type BusyLedger } from './engine-failures.js'
import { ActionRunner } from './engine-runner.js'
import type { EngineStore } from './engine-store.js'
import type { RunnerContext } from './engine-writes.js'
import { isDirectory, lstatOrNull, sweepTrash } from './local-fs.js'
import { LocalScanner } from './local-scan.js'
import type { HeldDeleteDecision } from './reconcile-model.js'
import { reconcile } from './reconciler.js'
import { ConflictBook, countEntries, engineStateOf, heartbeatSummaryOf } from './report.js'
import { ensureFolderSyncDirectories, folderSyncPaths, takeConsoleRequests, type FolderSyncPaths } from './state-files.js'
import { TeamNames } from './team-names.js'
import { isTransientSyncError, syncErrorCode, type FolderSyncTransport } from './transport.js'

/**
 * One pass of folder sync (plan §2.6–2.7): handshake, replay what a crash or
 * a lost answer left pending, pull, scan, plan with the pure reconciler, act,
 * then report. A pass is self-contained; `engine-loop.ts` decides when the
 * next one runs.
 */

export type FolderSyncEngineOptions = {
  stateDir: string
  executorId: string
  transport: FolderSyncTransport
  security?: StateSecurityDeps
  now?: () => number
  /**
   * Names this computer in conflicted copies and change comments. Nessie's
   * own label for it, from the handshake, unless set (the simulator's
   * computers share one fake server).
   */
  computerLabel?: string
  utcOffsetMinutes?: () => number
  /**
   * Downloads and uploads run at once (default `FOLDER_SYNC_CONCURRENCY`). The
   * simulator runs one at a time where a replay must repeat every detail.
   */
  transferConcurrency?: { downloads: number; uploads: number }
}

export type PassOptions = {
  /** Team-relative subtrees to walk; null walks everything. */
  scope?: readonly string[] | null
  snapshot?: boolean
}

export type PassResult = {
  /** The pass changed something or was cut short: run another soon. */
  more: boolean
  /** Something is waiting to settle: look again in this long. */
  retryInMs: number | null
  /** Where the next look should go (null: everywhere). */
  retryScope: string[] | null
  /** The engine is not syncing (off, paused, waiting for Nessie, folder missing). */
  idle: boolean
  /**
   * Something waits on a person (an open conflict, held deletes): their choice
   * in Nessie arrives only in a report answer, so the loop reports again soon.
   */
  awaitingPerson: boolean
}

const IDLE: PassResult = { more: false, retryInMs: null, retryScope: null, idle: true, awaitingPerson: false }
const STOP_STATUS: Record<string, FolderSyncRecordStatus | 'not_private'> = {
  [CODES.PAUSED]: 'paused',
  [CODES.DISABLED]: 'disabled',
  [CODES.REAUTHORIZE]: 'needs_reauthorization',
  [CODES.NOT_CONFIRMED]: 'requested',
  [CODES.NOT_REQUESTED]: 'requested',
  [CODES.PRIVATE_ONLY]: 'not_private',
}
const REPORT_EVERY_MS = 10 * 60 * 1000
const TRASH_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000

export class FolderSyncEngine {
  readonly paths: FolderSyncPaths
  private readonly now: () => number
  private readonly scanner = new LocalScanner()
  private readonly busy: BusyLedger = new Map()
  private readonly names: TeamNames
  private store: EngineStore | null = null
  private book: ConflictBook | null = null
  private handshake: FolderSyncHandshakeResponse | null = null
  private serverStatus: FolderSyncRecordStatus | 'not_private' | null = null
  private status: FolderSyncStatusFile | null = null
  private config: FolderSyncConfig | null = null
  private heldDecision: HeldDeleteDecision | null = null
  private diskFull = false
  private lastReportKey = ''
  private lastReportAt = 0
  private lastTrashSweep = 0
  private lastStatusKey = ''
  private directoriesReady = false
  private handshakeRoot: string | null = null
  offline = false

  constructor(private readonly options: FolderSyncEngineOptions) {
    this.paths = folderSyncPaths(options.stateDir)
    this.now = options.now ?? Date.now
    this.names = new TeamNames(options.transport, () => this.now())
  }

  /** The team folder, once the handshake has named it. */
  teamDir(): string | null {
    return this.config?.root && this.config.teamFolder ? join(this.config.root, this.config.teamFolder) : null
  }

  /** The heartbeat's `folderSync` summary; absent while sync was never switched on here. */
  summary(): FolderSyncHeartbeatSummary | undefined {
    if (!this.config?.root || !this.status) return undefined
    return heartbeatSummaryOf(this.config.enabled, this.status.state, this.status.counts, this.status.lastReconcileAt)
  }

  async runPass(options: PassOptions = {}): Promise<PassResult> {
    if (!this.directoriesReady) {
      await ensureFolderSyncDirectories(this.paths, this.options.security)
      this.directoriesReady = true
    }
    this.status ??= await readStatusFile(this.options.stateDir)
    this.book ??= await ConflictBook.open(this.paths.conflicts, this.options.security)
    const config = await loadFolderSyncConfig(this.options.stateDir)
    this.config = config
    // Until the team folder is named, its names say where files will go (`team-names.ts`).
    if (!config.teamFolder) Object.assign(this.status!, await this.names.learn(this.status!))
    if (!config.enabled || !config.root) return this.settle({ state: 'off' })
    if (config.paused) {
      await this.reportQuietly()
      return this.settle({ state: 'paused' })
    }
    try {
      return await this.pass(config, options)
    } catch (error) {
      // Any call of the pass may be the one that learns Nessie stopped this
      // computer: a pull refused as turned off is a stop, not a failure to retry.
      const stopCode = error instanceof StopPassError ? error.code : syncErrorCode(error)
      if (stopCode && STOP_STATUS[stopCode]) {
        this.serverStatus = STOP_STATUS[stopCode] ?? this.serverStatus
        if (this.serverStatus === 'disabled') await switchFolderSyncOffHere(this.options.stateDir, this.options.security)
        this.handshake = this.serverStatus === 'live' ? this.handshake : null
        return this.settle({})
      }
      if (isTransientSyncError(error)) {
        this.offline = true
        await this.settle({})
      }
      throw error
    }
  }

  private async pass(config: FolderSyncConfig, options: PassOptions): Promise<PassResult> {
    const { executorId, transport } = this.options
    const book = this.book!
    // Again whenever another folder was chosen: the handshake names its label.
    if (!this.handshake || this.serverStatus !== 'live' || this.handshakeRoot !== config.root) {
      try {
        this.handshake = await transport.handshake({
          rootLabel: folderSyncRootLabel(config.root!), includeSensitive: config.includeSensitive,
        })
        this.serverStatus = this.handshake.status
        this.handshakeRoot = config.root
      } catch (error) {
        const code = syncErrorCode(error)
        if (code && STOP_STATUS[code]) throw new StopPassError(code)
        throw error
      }
      this.offline = false
    }
    if (this.serverStatus !== 'live') {
      await this.reportQuietly()
      return this.settle({})
    }
    const rootPresent = await syncRootPresent(config, executorId)
    if (!rootPresent) {
      await this.reportQuietly()
      return this.settle({ state: 'root_missing' })
    }
    const teamDir = await ensureTeamFolder(config, {
      stateDir: this.options.stateDir, executorId, now: this.now(), security: this.options.security,
      names: () => this.names.forNewFolder(this.handshake!),
    })
    const store = await this.openStore(config)
    if (store.entries().length === 0 && !await isDirectory(teamDir)) await mkdir(teamDir, { recursive: true })
    const teamFolderPresent = await isDirectory(teamDir)
    if (this.now() - this.lastTrashSweep > TRASH_SWEEP_EVERY_MS) {
      await sweepTrash(this.paths.trash, this.now())
      this.lastTrashSweep = this.now()
    }

    const ctx = this.context(teamDir, store)
    let more = false
    ctx.replan = () => { more = true }
    // Replay first: an install whose bookkeeping never came, then every action
    // a crash or a lost answer left pending, each re-checking what it expects.
    const replayer = new ActionRunner(ctx, this.busy)
    const settled = await replayer.settleInstalls()
    const pending = store.index.pending.filter((item) => !settled.has(item.actionId))
    if (pending.length > 0) {
      await replayer.recoverReplaces(pending)
      const ids = new Map(pending.map((item) => [item.action, item.actionId]))
      await replayer.run(pending.map((item) => item.action), ids)
      await this.persistPages(store, ctx)
      ctx.pages = new Map(store.index.manifest.pages.map((page) => [page.id, page]))
      more = true
    }

    const pulled = await pullRemote(store, transport, executorId, {
      snapshot: options.snapshot === true, takenAt: new Date(this.now()).toISOString(),
    })
    this.offline = false
    if (pulled.excludedSpaces) this.status!.excludedSpaces = pulled.excludedSpaces
    ctx.pages = new Map(store.index.manifest.pages.map((page) => [page.id, page]))

    for (const request of await takeConsoleRequests(this.paths)) {
      if (request.kind === 'held_deletes') this.heldDecision = { batchId: request.batchId, decision: request.decision }
      else await applyResolution(ctx, { ...request, expectedOccurredAt: null })
    }

    const now = this.now()
    // While deletes are held, every pass walks the whole folder: a scoped pass
    // (a watcher hint, journal news) sees none of them, so it dropped the held
    // set — and any decision a person sent for it — until the next full reconcile.
    const wanted = this.status?.heldDeletes ? null : options.scope
    const scope = wanted ? await this.scanner.canonicalScope(teamDir, wanted) : null
    const scan = await this.scanner.scan(teamDir, store.entries(), scope, now)
    const plan = reconcile({
      now,
      passId: randomUUID(),
      computerLabel: this.options.computerLabel ?? this.handshake!.computerLabel,
      utcOffsetMinutes: this.options.utcOffsetMinutes?.() ?? -new Date(now).getTimezoneOffset(),
      maxUploadBytes: this.handshake!.limits.maxUploadBytes ?? FOLDER_SYNC_MAX_FILE_BYTES,
      entries: store.entries(),
      local: { rootPresent, teamFolderPresent, scope, items: scan.items },
      remote: store.index.manifest,
      knownConflictIds: new Set([
        ...store.index.knownConflictIds, ...book.open().map((row) => row.report.clientConflictId),
      ]),
      mergeBases: store.mergeBases(),
      heldDecision: this.heldDecision,
      spaceDirs: store.index.spaceDirs,
    })
    const effects = plan.actions.filter((action) => action.type !== 'recordConflict' && action.type !== 'setEntryState')
    await this.writeStatus({
      activity: {
        uploading: effects.filter((a) => a.type === 'upload' || a.type === 'merge' || a.type === 'createRemote').length,
        downloading: effects.filter((a) => a.type === 'download').length,
      },
    })

    const runner = new ActionRunner(ctx, this.busy)
    await runner.run(plan.actions)
    this.diskFull = runner.diskFull
    if (runner.executed > 0 || runner.replanNeeded) more = true
    await this.persistPages(store, ctx)
    const top = await readdir(teamDir, { withFileTypes: true }).catch(() => [])
    const topDirs = new Set(top.filter((item) => item.isDirectory()).map((item) => item.name))
    await store.setSpaceDirs(spaceDirsNow(store.index.manifest, store.index.spaceDirs, topDirs))

    // Rows raised last (A12.9): this pass's copies, then any open conflict
    // whose copy page exists but whose row was never raised (a replayed chain).
    const occurredAt = new Date(this.now()).toISOString()
    const rows = runner.copyReports(occurredAt)
    for (const entry of store.entries()) {
      const open = entry.openConflict
      const raised = (id: string) => book.has(id) || rows.some((row) => row.clientConflictId === id)
      if (!open?.copyPageId || raised(open.clientConflictId)) continue
      rows.push({
        clientConflictId: open.clientConflictId, kind: 'conflicted_copy', reason: 'edited_on_both_sides',
        relPath: entry.relPath, pageId: entry.pageId, occurredAt,
        copy: {
          relPath: open.copyRelPath, pageId: open.copyPageId, ...(open.copyHash ? { contentHash: open.copyHash } : {}),
        },
        headVersionId: ctx.pages.get(entry.pageId)?.head?.versionId ?? null,
      })
    }
    await book.add(rows)
    await store.rememberConflicts(rows.map((row) => row.clientConflictId))

    const byPath = new Map(scan.items.map((item) => [item.relPath, item]))
    const acted = new Set([...runner.touched, ...replayer.touched])
    for (const entry of refreshedEntries(store.entries(), store.index.manifest, byPath, (id) => !acted.has(id), now)) {
      await store.put(entry)
    }
    if (this.heldDecision && plan.heldDeletes?.batchId !== this.heldDecision.batchId) this.heldDecision = null

    // A new folder waits to be still too: without a retry it would wait for the next full reconcile.
    const unsettled = scan.items.filter((item) => item.type !== 'link'
      && (item.unopenableSinceMs !== null || now - item.stableSinceMs < FOLDER_SYNC_STABLE_MS))
    const retryAts = store.entries()
      .map((entry) => entry.detail?.retryAt)
      .filter((at): at is number => at !== undefined && at > now)
    const retryInMs = unsettled.length > 0 ? FOLDER_SYNC_STABLE_MS
      : retryAts.length > 0 ? Math.max(FOLDER_SYNC_TIMING.backoffInitialMs, Math.min(...retryAts) - now) : null
    const retryScope = unsettled.length > 0 && retryAts.length === 0 ? unsettled.map((item) => item.relPath) : null

    const notSynced = notSyncedItems(store.index.manifest, this.status!.excludedSpaces, scan.links)
    const counts = countEntries(
      store.entries(), runner.remainder, book.openNeedingAttention(), plan.heldDeletes, notSynced.count,
    )
    this.status = {
      ...this.status!,
      heldDeletes: plan.heldDeletes,
      notSynced: notSynced.items,
      counts,
      lastReconcileAt: new Date(now).toISOString(),
    }
    // A choice made in Nessie arrives with the report: the next pass carries it out.
    if (await this.report()) more = true
    const result = await this.settle({ activity: { uploading: 0, downloading: 0 } })
    return {
      ...result, more: more || result.more, retryInMs, retryScope, idle: false,
      awaitingPerson: this.awaitingPerson(),
    }
  }

  private context(teamDir: string, store: EngineStore): RunnerContext {
    return {
      teamDir,
      paths: this.paths,
      store,
      transport: this.options.transport,
      pages: new Map(store.index.manifest.pages.map((page) => [page.id, page])),
      gone: new Set(),
      scanner: this.scanner,
      book: this.book!,
      now: this.now,
      pageKeys: new Map(),
      ownRevisions: new Map(),
      copiesCreated: new Map(),
      replan: () => undefined,
      security: this.options.security ?? {},
      concurrency: this.options.transferConcurrency ?? FOLDER_SYNC_CONCURRENCY,
    }
  }

  private async persistPages(store: EngineStore, ctx: RunnerContext): Promise<void> {
    const next = manifestWith(store.index.manifest, ctx.pages, ctx.gone)
    if (JSON.stringify(next.pages) !== JSON.stringify(store.index.manifest.pages)) {
      await store.replaceManifest(next, store.index.cursors)
    }
  }

  /** The store for the chosen folder's index, kept while its identity holds (`engine-folder.ts`). */
  private async openStore(config: FolderSyncConfig): Promise<EngineStore> {
    const current = await folderIndexOwner(this.paths)
    if (this.store && current === config.syncId) return this.store
    if (current !== config.syncId) {
      this.store = null
      await resetFolderIndex(this.paths, config.syncId)
    }
    this.store = await openFolderStore(this.paths, this.options.security)
    return this.store
  }

  /**
   * Send the report when something changed (or every ten minutes); apply
   * Nessie's answer. True when it carried a person's decision that acted here.
   */
  private async report(): Promise<boolean> {
    const book = this.book!
    const status = this.status!
    const outbox = book.outbox()
    const state = this.stateNow()
    const key = JSON.stringify({ state, counts: status.counts, held: status.heldDeletes?.batchId ?? null })
    const quiet = outbox.conflicts.length === 0 && outbox.resolved.length === 0
    const every = this.awaitingPerson() ? 0 : REPORT_EVERY_MS
    if (quiet && key === this.lastReportKey && this.now() - this.lastReportAt < every) return false
    const answer = await this.options.transport.report({
      state, counts: status.counts, lastReconcileAt: status.lastReconcileAt, heldDeletes: status.heldDeletes, ...outbox,
    })
    await book.delivered(outbox)
    this.lastReportKey = key
    this.lastReportAt = this.now()
    this.serverStatus = answer.status
    if (answer.status === 'disabled') await switchFolderSyncOffHere(this.options.stateDir, this.options.security)
    if (answer.status !== 'live') this.handshake = null
    let decided = false
    const held = answer.instructions.heldDeletes
    if (held && held.batchId === status.heldDeletes?.batchId) {
      decided = this.heldDecision?.batchId !== held.batchId || this.heldDecision.decision !== held.decision
      this.heldDecision = held
    }
    if (answer.instructions.resolveConflicts.length > 0 && this.store && this.teamDir()) {
      const ctx = this.context(this.teamDir()!, this.store)
      for (const choice of answer.instructions.resolveConflicts) {
        const outcome = await applyResolution(ctx, { ...choice, expectedOccurredAt: choice.expectedOccurredAt ?? null })
        if (outcome !== 'not_found') decided = true
      }
    }
    return decided
  }

  /** An open conflict or held deletes: a person's decision may be waiting in Nessie. */
  private awaitingPerson(): boolean {
    return (this.status?.counts.openConflicts ?? 0) > 0 || this.status?.heldDeletes != null
  }

  /** Report outside a syncing pass (paused, waiting, folder missing); a failure only marks offline. */
  private async reportQuietly(): Promise<void> {
    if (this.serverStatus === null || this.serverStatus === 'not_private') return
    try {
      await this.report()
    } catch (error) {
      const code = syncErrorCode(error)
      if (code && STOP_STATUS[code]) this.serverStatus = STOP_STATUS[code]!
      else if (isTransientSyncError(error)) this.offline = true
      else throw error
    }
  }

  private stateNow(override?: FolderSyncStatusFile['state']) {
    return override ?? engineStateOf({
      enabled: this.config?.enabled === true && this.config.root !== null,
      paused: this.config?.paused === true,
      serverStatus: this.serverStatus,
      rootPresent: true,
      diskFull: this.diskFull,
      offline: this.offline,
      snapshotTaken: this.store?.index.manifest.snapshotAt != null,
      counts: this.status?.counts ?? EMPTY_COUNTS,
    })
  }

  /**
   * Written only when something other than its time changed: an idle engine
   * (sync off) passes every few seconds, and on Windows every private write
   * runs the state-security helper.
   */
  private async writeStatus(patch: Partial<FolderSyncStatusFile>): Promise<void> {
    this.status = { ...this.status!, ...patch }
    const key = JSON.stringify({ ...this.status, updatedAt: null })
    if (key === this.lastStatusKey) return
    await writeStatusFile(this.options.stateDir, this.status, this.options.security)
    this.lastStatusKey = key
  }

  private async settle(patch: Partial<FolderSyncStatusFile>): Promise<PassResult> {
    const state = this.stateNow(patch.state)
    await this.writeStatus({
      ...patch,
      state,
      serverStatus: this.serverStatus === 'not_private' ? null : this.serverStatus,
      manageUrl: this.handshake?.manageUrl ?? this.status?.manageUrl ?? null,
      teamLabel: this.handshake?.teamLabel ?? this.status?.teamLabel ?? null,
      organizationName: this.handshake?.organizationName ?? this.status?.organizationName ?? null,
      updatedAt: new Date(this.now()).toISOString(),
    })
    return IDLE
  }

  /**
   * Between passes: long-poll the journal (up to 25 s). Rows are folded into
   * the manifest at once; the answer says whether anyone but this computer
   * wrote, or a snapshot is needed. Answers null while sync is not live.
   */
  async waitForNews(signal: AbortSignal): Promise<{ news: boolean; snapshot: boolean } | null> {
    const store = this.store
    if (!store || this.serverStatus !== 'live' || !this.config?.enabled || this.config.paused) return null
    const answer = await this.options.transport.changes(store.index.cursors, true, signal)
    const news = hasNews(answer, store, this.options.executorId)
    return { news, snapshot: await foldChanges(store, answer) }
  }

  /** True while the root's marker is present: used by the loop to arm its watcher. */
  async watchable(): Promise<boolean> {
    const dir = this.teamDir()
    return dir !== null && (await lstatOrNull(dir))?.type === 'directory'
  }
}
