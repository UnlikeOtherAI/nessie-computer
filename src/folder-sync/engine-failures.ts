import { EXECUTOR_FOLDER_SYNC_ERROR_CODES as CODES, FOLDER_SYNC_TIMING } from '@nessie/executor-protocol'

import { DocumentUnsendableError, DownloadCorruptError, type RunnerContext } from './engine-writes.js'
import { FolderSyncFileBusyError, FolderSyncLocalDriftError, FolderSyncPathRefusedError } from './local-fs.js'
import { conflictIdFor } from './reconcile-model.js'
import { TornReadError, conflictDetails, refusedAsOtherSpace, syncErrorCode } from './transport.js'
import type { ReconcileAction, SyncEntry } from './types.js'

/**
 * What a failed action means (the error table in
 * `docs/standards/folder-sync.md`): a drift, a torn read or a 409 replans with
 * what the server said; a held file waits with backoff and is reported after
 * five minutes (C18); too large or storage full rests an hour (C15); a code
 * that stops sync ends the pass.
 */

/** Nessie stopped this computer's sync: the pass ends and the state follows the code. */
export class StopPassError extends Error {
  constructor(readonly code: string) {
    super(`Folder sync stopped: ${code}.`)
  }
}

export const STOP_CODES = new Set<string>([
  CODES.PAUSED, CODES.DISABLED, CODES.REAUTHORIZE, CODES.NOT_CONFIRMED, CODES.PRIVATE_ONLY, CODES.NOT_REQUESTED,
])

/** How long a held file has waited, kept by the engine across passes. */
export type BusyLedger = Map<string, { since: number; attempts: number }>

const HOUR_MS = 60 * 60 * 1000

const raise = async (
  ctx: RunnerContext,
  reason: 'file_in_use' | 'too_large' | 'storage_full',
  subject: { pageId: string | null; relPath: string },
  discriminator: string,
): Promise<void> => {
  if (subject.relPath === '') return
  const clientConflictId = conflictIdFor(reason, subject, discriminator)
  if (ctx.book.has(clientConflictId)) return
  await ctx.book.add([{
    clientConflictId, kind: 'error', reason, relPath: subject.relPath, pageId: subject.pageId, copy: null,
    occurredAt: new Date(ctx.now()).toISOString(),
    headVersionId: subject.pageId ? ctx.pages.get(subject.pageId)?.head?.versionId ?? null : null,
  }])
  await ctx.store.rememberConflicts([clientConflictId])
}

export const recordFailure = async (
  ctx: RunnerContext,
  busy: BusyLedger,
  action: ReconcileAction,
  pageId: string | null,
  relPath: string,
  error: unknown,
): Promise<'replan' | 'disk_full'> => {
  const code = syncErrorCode(error)
  if (code !== null && STOP_CODES.has(code)) throw new StopPassError(code)
  const entry = pageId ? ctx.store.entry(pageId) : undefined
  const now = ctx.now()
  const setError = async (detailCode: NonNullable<SyncEntry['detail']>['code'], message: string, retryAt: number) => {
    if (entry) await ctx.store.put({ ...entry, state: 'error', detail: { code: detailCode, message, retryAt } })
  }
  const replans = [FolderSyncLocalDriftError, TornReadError, DownloadCorruptError]
  if (replans.some((kind) => error instanceof kind)) {
    return 'replan'
  }
  const details = conflictDetails(error)
  if (details) {
    ctx.pages.set(details.page.id, details.page)
    ctx.gone.delete(details.page.id)
    return 'replan'
  }
  if (error instanceof FolderSyncFileBusyError) {
    const key = pageId ?? relPath
    const ledger = busy.get(key) ?? { since: now, attempts: 0 }
    ledger.attempts += 1
    busy.set(key, ledger)
    const { backoffInitialMs, backoffMaxMs } = FOLDER_SYNC_TIMING
    const wait = Math.min(backoffMaxMs, backoffInitialMs * 2 ** (ledger.attempts - 1))
    const long = now - ledger.since >= FOLDER_SYNC_TIMING.waitingReportedAfterMs
    if (entry) {
      await ctx.store.put({
        ...entry, state: 'waiting',
        detail: { code: long ? 'file_in_use' : 'not_stable', message: 'Waiting for the file to close.', retryAt: now + wait },
      })
    }
    if (long) await raise(ctx, 'file_in_use', { pageId, relPath }, String(ledger.since))
    return 'replan'
  }
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') return 'disk_full'
  if (code === CODES.NOT_FOUND && pageId) {
    ctx.pages.delete(pageId)
    ctx.gone.add(pageId)
    return 'replan'
  }
  // A move into another space's folder: the page is still writable. The
  // replan plans that move as refused, puts the file back and says why.
  if (refusedAsOtherSpace(error)) return 'replan'
  if (code === CODES.READ_ONLY && pageId) {
    const page = ctx.pages.get(pageId)
    if (page) ctx.pages.set(pageId, { ...page, readOnly: true, readOnlyReason: 'no_write_access' })
    return 'replan'
  }
  if (code === CODES.TOO_LARGE || code === CODES.QUOTA_EXCEEDED || error instanceof DocumentUnsendableError) {
    const reason = code === CODES.QUOTA_EXCEEDED ? 'storage_full' as const : 'too_large' as const
    await setError(reason, error instanceof Error ? error.message : reason, now + HOUR_MS)
    await raise(ctx, reason, { pageId, relPath }, String(Math.floor(now / HOUR_MS)))
    return 'replan'
  }
  if (error instanceof FolderSyncPathRefusedError) {
    await setError('name_not_supported', error.message, now + HOUR_MS)
    return 'replan'
  }
  if (code === CODES.UPLOAD_INVALID || code === CODES.UPLOAD_EXPIRED) return 'replan'
  // An answer this engine does not act on: the entry rests and is tried again later.
  await setError(code === CODES.OPERATION_MISMATCH ? CODES.OPERATION_MISMATCH : 'transport_failed',
    error instanceof Error ? error.message : String(error), now + FOLDER_SYNC_TIMING.backoffMaxMs)
  console.error('[nessie-executor] folder sync action failed:', action.type, error instanceof Error ? error.message : error)
  return 'replan'
}
