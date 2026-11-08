import { z } from 'zod'

import { canonicalExecutorJson } from './executor-canonical.js'
import {
  ExecutorDaemonHeartbeatRequestSchema,
  Sha256DigestSchema,
} from './executor.js'
import { KnowledgePageKindSchema } from './knowledge.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * Folder sync: two-way sync between a person's Documents in one paired team
 * and a folder on their private computer, run by the executor daemon.
 *
 * This module holds the vocabulary every side shares — limits, error codes,
 * states, and the report and heartbeat summaries. Beside it:
 * `-projections` (spaces, pages, journal rows the server sends), `-conflicts`
 * (conflict kinds, reason codes, the matrix map), `-daemon` (the daemon's
 * signed wire) and `-person` (the person routes and the native console). The
 * standard is `docs/standards/folder-sync.md`.
 */

// ── Signing ────────────────────────────────────────────────────────────────

/**
 * The domain name the daemon signing helpers take. Every sync request — JSON
 * bodies and the header envelopes of the byte routes — signs under it; the
 * signed `operation` field keeps one request from being replayed as another.
 */
export const EXECUTOR_FOLDER_SYNC_SIGNATURE_DOMAIN = 'sync' as const
/** The full signature context the domain expands to. */
export const EXECUTOR_FOLDER_SYNC_SIGNATURE_CONTEXT = 'nessie.executor.daemon.sync.v1' as const

// ── Limits ─────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024

/** One upload part, and the largest file sent in a single part. */
export const FOLDER_SYNC_PART_BYTES = 8 * MIB
/** The hard ceiling on one file; the handshake may announce a lower one. */
export const FOLDER_SYNC_MAX_FILE_BYTES = 5 * 1024 * MIB
/** The most parts one upload session may have. */
export const FOLDER_SYNC_MAX_PARTS = Math.ceil(FOLDER_SYNC_MAX_FILE_BYTES / FOLDER_SYNC_PART_BYTES)
/** A document's Markdown, in UTF-8 bytes — the same cap as Markdown import. */
export const FOLDER_SYNC_MARKDOWN_MAX_BYTES = 5 * MIB
/** The largest text file a three-way merge is attempted on. */
export const FOLDER_SYNC_MERGE_MAX_BYTES = 5 * MIB
/** A local change is acted on only after it has been still this long. */
export const FOLDER_SYNC_STABLE_MS = 2_000
/** One pass archiving more than `max(min, fraction × entries)` is held. */
export const FOLDER_SYNC_DELETE_BRAKE = { min: 10, fraction: 0.2 } as const
const ARCHIVED_BYTES_RETENTION_DAYS = 30
/**
 * How much longer the journal keeps a row than the purge keeps archived bytes.
 * The purge finds a sync archive by its `page_archived` row (stamped with the
 * database's transaction start) but waits on the page's `archivedAt` (the
 * application's clock, read later in that transaction), so the row has to
 * outlive the bytes' window or the prune could take it in the very tick that
 * skips the page, and its bytes would never be purged.
 */
export const FOLDER_SYNC_JOURNAL_RETENTION_MARGIN_DAYS = 1
/** How long each kind of kept copy is kept. */
export const FOLDER_SYNC_RETENTION_DAYS = {
  /** Server journal rows; an older cursor is expired. Derived, never set on its own. */
  journal: ARCHIVED_BYTES_RETENTION_DAYS + FOLDER_SYNC_JOURNAL_RETENTION_MARGIN_DAYS,
  /** File bytes of a page sync archived, before the purge sweep. */
  archivedBytes: ARCHIVED_BYTES_RETENTION_DAYS,
  /** Local recycle copies under the state directory's `trash/`. */
  localTrash: 30,
} as const
/** An upload session that is not completed in this time is abandoned. */
export const FOLDER_SYNC_UPLOAD_SESSION_MS = 24 * 60 * 60 * 1000
/** The engine's timing. */
export const FOLDER_SYNC_TIMING = {
  pullIntervalMs: 5_000,
  longPollMs: 25_000,
  fullReconcileMs: 10 * 60 * 1000,
  /** Every Nth periodic reconcile also takes a full snapshot. */
  snapshotEveryReconciles: 6,
  backoffInitialMs: 1_000,
  backoffMaxMs: 5 * 60 * 1000,
  /** A file still locked after this long is reported (`file_in_use`). */
  waitingReportedAfterMs: 5 * 60 * 1000,
} as const
export const FOLDER_SYNC_CONCURRENCY = { downloads: 3, uploads: 2 } as const
/** Page sizes of the paged answers. */
export const FOLDER_SYNC_SNAPSHOT_PAGE_SIZE = 500
export const FOLDER_SYNC_CHANGES_PAGE_SIZE = 500
/** Path mapping caps, in UTF-8 bytes. */
export const FOLDER_SYNC_PATH_LIMITS = { segmentBytes: 200, relativePathBytes: 900 } as const
/** Bounded lists inside one report. */
export const FOLDER_SYNC_REPORT_LIMITS = {
  conflicts: 200,
  resolved: 500,
  heldDeleteSample: 20,
} as const
export const FOLDER_SYNC_TITLE_MAX_LENGTH = 1_000
export const FOLDER_SYNC_CHANGE_COMMENT_MAX_LENGTH = 500

// ── Error codes ────────────────────────────────────────────────────────────

/**
 * Every code a sync route answers with, in the `{ error: { code } }` envelope.
 * Signature, epoch and freshness failures keep the daemon's existing codes
 * (`EXECUTOR_CONNECTION_FENCED`, `EXECUTOR_HEARTBEAT_STALE`, …).
 */
export const EXECUTOR_FOLDER_SYNC_ERROR_CODES = {
  /** No sync row exists for this executor: handshake first. */
  NOT_REQUESTED: 'EXECUTOR_FOLDER_SYNC_NOT_REQUESTED',
  /** Requested but the owner has not allowed it in Nessie yet. */
  NOT_CONFIRMED: 'EXECUTOR_FOLDER_SYNC_NOT_CONFIRMED',
  /** The executor is not `private`; sync is refused. */
  PRIVATE_ONLY: 'EXECUTOR_FOLDER_SYNC_PRIVATE_ONLY',
  /** Paused in Nessie; reads may continue, writes are refused. */
  PAUSED: 'EXECUTOR_FOLDER_SYNC_PAUSED',
  /** Turned off in Nessie; the daemon stops. */
  DISABLED: 'EXECUTOR_FOLDER_SYNC_DISABLED',
  /** The captured authority was denied; the owner must reauthorize. */
  REAUTHORIZE: 'EXECUTOR_FOLDER_SYNC_REAUTHORIZE',
  /** Authority could not be decided now; retry with backoff (503). */
  UNAVAILABLE: 'EXECUTOR_FOLDER_SYNC_UNAVAILABLE',
  /** The base revision is stale; `details` carries the head and why (409). */
  CONFLICT: 'EXECUTOR_FOLDER_SYNC_CONFLICT',
  /** An `operationKey` already names a different request (409). */
  OPERATION_MISMATCH: 'EXECUTOR_FOLDER_SYNC_OPERATION_MISMATCH',
  /** A snapshot paging cursor is unknown or too old: start the snapshot again. */
  CURSOR_EXPIRED: 'EXECUTOR_FOLDER_SYNC_CURSOR_EXPIRED',
  /** The owner may read the page but not write it (R1). */
  READ_ONLY: 'EXECUTOR_FOLDER_SYNC_READ_ONLY',
  /** The page or space is gone or no longer readable by the owner. */
  NOT_FOUND: 'EXECUTOR_FOLDER_SYNC_NOT_FOUND',
  /** The file exceeds the upload ceiling. */
  TOO_LARGE: 'EXECUTOR_FOLDER_SYNC_TOO_LARGE',
  /** The owner's storage quota is exhausted. */
  QUOTA_EXCEEDED: 'EXECUTOR_FOLDER_SYNC_QUOTA_EXCEEDED',
  /** A part or whole-file digest, size or count did not match. */
  UPLOAD_INVALID: 'EXECUTOR_FOLDER_SYNC_UPLOAD_INVALID',
  /** The upload session expired or is unknown: begin again. */
  UPLOAD_EXPIRED: 'EXECUTOR_FOLDER_SYNC_UPLOAD_EXPIRED',
  /** A byte route's header envelope is missing or malformed. */
  ENVELOPE_INVALID: 'EXECUTOR_FOLDER_SYNC_ENVELOPE_INVALID',
  RATE_LIMITED: 'EXECUTOR_FOLDER_SYNC_RATE_LIMITED',
  /** Person routes: only the pairing owner may do this. */
  OWNER_ONLY: 'EXECUTOR_FOLDER_SYNC_OWNER_ONLY',
  /** Person routes: the held batch changed since the screen was drawn. */
  HELD_DELETES_CHANGED: 'EXECUTOR_FOLDER_SYNC_HELD_DELETES_CHANGED',
  /** Person routes: the status does not allow this transition. */
  STATE_INVALID: 'EXECUTOR_FOLDER_SYNC_STATE_INVALID',
} as const
export type ExecutorFolderSyncErrorCode =
  (typeof EXECUTOR_FOLDER_SYNC_ERROR_CODES)[keyof typeof EXECUTOR_FOLDER_SYNC_ERROR_CODES]

/** Codes a daemon retries with backoff rather than re-planning. */
export const EXECUTOR_FOLDER_SYNC_RETRYABLE_ERROR_CODES: readonly ExecutorFolderSyncErrorCode[] = [
  EXECUTOR_FOLDER_SYNC_ERROR_CODES.UNAVAILABLE,
  EXECUTOR_FOLDER_SYNC_ERROR_CODES.RATE_LIMITED,
  EXECUTOR_FOLDER_SYNC_ERROR_CODES.UPLOAD_EXPIRED,
]

// ── Primitives ─────────────────────────────────────────────────────────────

const UuidSchema = z.string().uuid()
export const FolderSyncPageIdSchema = UuidSchema
export const FolderSyncSpaceIdSchema = UuidSchema
export const FolderSyncVersionIdSchema = UuidSchema
/** Every content hash and digest is `sha256:<64 hex>`. */
export const FolderSyncContentHashSchema = Sha256DigestSchema

/** Archive guard input: SHA-256 of these sorted descendant id/revision pairs. */
export const canonicalFolderSyncDescendantRevisions = (pages: readonly { id: string; revision: number }[]): string =>
  canonicalExecutorJson([...pages].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((page) => [page.id, page.revision]))
/** A journal sequence number: a decimal BIGSERIAL, carried as a string. */
export const FolderSyncSeqSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/)
export type FolderSyncSeq = z.infer<typeof FolderSyncSeqSchema>
/** Per-space journal cursors: `{ [spaceId]: seq }`. */
export const FolderSyncCursorsSchema = z.record(FolderSyncSpaceIdSchema, FolderSyncSeqSchema)
export type FolderSyncCursors = z.infer<typeof FolderSyncCursorsSchema>
export const FolderSyncTitleSchema = z.string().min(1).max(FOLDER_SYNC_TITLE_MAX_LENGTH)
export const FolderSyncChangeCommentSchema = z.string().min(1).max(FOLDER_SYNC_CHANGE_COMMENT_MAX_LENGTH)
/** The basename of the sync root — the only part of a host path ever sent. */
export const FolderSyncRootLabelSchema = z.string().min(1).max(255).refine(
  (value) => !/[\\/\0]/.test(value),
  'A root label is a basename, never a path.',
)

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

/**
 * A path relative to the team folder (`<root>/<Team label>/`): forward
 * slashes, no leading slash, no empty, `.` or `..` segment, no NUL or
 * backslash. It names documents, never host locations.
 */
export const FolderSyncRelPathSchema = z
  .string()
  .min(1)
  .max(FOLDER_SYNC_PATH_LIMITS.relativePathBytes)
  .refine((value) => (
    !value.startsWith('/')
    && !/[\\\0]/.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    && utf8Length(value) <= FOLDER_SYNC_PATH_LIMITS.relativePathBytes
  ), 'A relative path has forward-slash segments only, none empty, "." or "..".')
export type FolderSyncRelPath = z.infer<typeof FolderSyncRelPathSchema>

/**
 * A team's folder under the sync root, forward slashes: `<Organisation>/<Team>`
 * for a sync set up since several teams share one main folder, or one
 * `<Team>` segment for an older one, which keeps its folder. Each segment is a
 * cleaned folder name of at most `segmentBytes`.
 */
export const FolderSyncTeamFolderSchema = z
  .string()
  .min(1)
  .max(FOLDER_SYNC_PATH_LIMITS.segmentBytes * 2 + 1)
  .refine((value) => {
    const segments = value.split('/')
    return segments.length <= 2 && !/[\\\0]/.test(value) && segments.every((segment) => (
      segment !== '' && segment !== '.' && segment !== '..' && utf8Length(segment) <= FOLDER_SYNC_PATH_LIMITS.segmentBytes
    ))
  }, 'A team folder is one or two cleaned folder names.')
export type FolderSyncTeamFolder = z.infer<typeof FolderSyncTeamFolderSchema>

/** Markdown bounded by its UTF-8 size (UTF-16 length is a lower bound). */
export const FolderSyncMarkdownSchema = z
  .string()
  .max(FOLDER_SYNC_MARKDOWN_MAX_BYTES)
  .refine((value) => utf8Length(value) <= FOLDER_SYNC_MARKDOWN_MAX_BYTES, 'The Markdown is over 5 MiB.')

// ── States ─────────────────────────────────────────────────────────────────

/** The server row's status (`ExecutorFolderSync.status`). */
export const FOLDER_SYNC_RECORD_STATUSES = [
  'requested',
  'live',
  'paused',
  'disabled',
  'needs_reauthorization',
  'error',
] as const
export const FolderSyncRecordStatusSchema = z.enum(FOLDER_SYNC_RECORD_STATUSES)
export type FolderSyncRecordStatus = z.infer<typeof FolderSyncRecordStatusSchema>

/** Why the server row is unhealthy (`ExecutorFolderSync.healthReason`). */
export const FOLDER_SYNC_HEALTH_REASONS = [
  'needs_reauthorization',
  'root_missing',
  'disk_full',
  'held_deletes',
  'engine_error',
] as const
export const FolderSyncHealthReasonSchema = z.enum(FOLDER_SYNC_HEALTH_REASONS)
export type FolderSyncHealthReason = z.infer<typeof FolderSyncHealthReasonSchema>

/** The engine's own state: the console's status line and the report's `state`. */
export const FOLDER_SYNC_ENGINE_STATES = [
  'off',
  'starting',
  'waiting_for_confirmation',
  'syncing',
  'up_to_date',
  'paused',
  'root_missing',
  'disk_full',
  'needs_attention',
  'needs_reauthorization',
  'offline',
  'not_private',
] as const
export const FolderSyncEngineStateSchema = z.enum(FOLDER_SYNC_ENGINE_STATES)
export type FolderSyncEngineState = z.infer<typeof FolderSyncEngineStateSchema>

/**
 * A local entry's state (`SyncEntry.state`). `synced` only after a write
 * answered `written`, `created` or `already_current` and the file re-hashed to
 * what was sent; `preserved` means the local bytes are safe in Nessie as a
 * conflicted copy (or were answered `remote_only`), not as the shared version.
 */
export const FOLDER_SYNC_ENTRY_STATES = [
  'synced',
  'preserved',
  'pending_upload',
  'pending_download',
  'pending_move',
  'pending_delete',
  'held_delete',
  'conflict',
  'quarantined',
  'waiting',
  'error',
] as const
export const FolderSyncEntryStateSchema = z.enum(FOLDER_SYNC_ENTRY_STATES)
export type FolderSyncEntryState = z.infer<typeof FolderSyncEntryStateSchema>

export const FolderSyncPageKindSchema = KnowledgePageKindSchema
export type FolderSyncPageKind = z.infer<typeof FolderSyncPageKindSchema>

/**
 * How a page round-trips: `exact` both ways, `lossy` (a document the folder
 * copy cannot hold — read-only), `oneway` (spreadsheets — read-only in v1).
 */
export const FolderSyncFidelitySchema = z.enum(['exact', 'lossy', 'oneway'])
export type FolderSyncFidelity = z.infer<typeof FolderSyncFidelitySchema>

/** Why a page is mirrored read-only. Each maps to an R1 reason code. */
export const FolderSyncReadOnlyReasonSchema = z.enum([
  'document_formatting',
  'spreadsheet',
  'published',
  'no_write_access',
])
export type FolderSyncReadOnlyReason = z.infer<typeof FolderSyncReadOnlyReasonSchema>

/** Why something readable is not on disk ("Not synced", and `verify`'s `skipped`). */
export const FOLDER_SYNC_SKIP_REASONS = [
  'restricted_space',
  'agent_private_space',
  'sensitive_excluded',
  'version_not_disclosed',
  'no_content_yet',
  'link',
  'ignored_name',
] as const
export const FolderSyncSkipReasonSchema = z.enum(FOLDER_SYNC_SKIP_REASONS)
export type FolderSyncSkipReason = z.infer<typeof FolderSyncSkipReasonSchema>

// ── Counts, held deletes, heartbeat ────────────────────────────────────────

export const FolderSyncCountsSchema = z
  .object({
    /** Entries tracked in the index (files and folders). */
    entries: z.number().int().nonnegative(),
    pendingUploads: z.number().int().nonnegative(),
    pendingDownloads: z.number().int().nonnegative(),
    openConflicts: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    heldDeletes: z.number().int().nonnegative(),
    notSynced: z.number().int().nonnegative(),
  })
  .strict()
export type FolderSyncCounts = z.infer<typeof FolderSyncCountsSchema>

/**
 * Whether counts allow `up_to_date`: nothing pending or waiting, no open
 * conflict, no entry resting in `error` (its change is in neither place yet)
 * and no deletion held for a person. The engine picks its state with this,
 * and the admin derives its Sync tab from the report's counts with it, never
 * from a 2xx; the console, tray and menu bar refuse the same counts.
 */
export const folderSyncCountsAreSettled = (counts: FolderSyncCounts): boolean =>
  counts.pendingUploads + counts.pendingDownloads + counts.waiting === 0 && counts.openConflicts === 0
  && counts.errors === 0 && counts.heldDeletes === 0

/**
 * Deletions the mass-delete brake is holding. `batchId` names this held set;
 * a person's confirm or restore names it back, so a set that changed after
 * the screen was drawn is never confirmed by mistake.
 */
export const FolderSyncHeldDeletesSchema = z
  .object({
    batchId: UuidSchema,
    count: z.number().int().positive(),
    sample: z.array(FolderSyncRelPathSchema).max(FOLDER_SYNC_REPORT_LIMITS.heldDeleteSample),
    reason: z.enum(['mass_delete', 'space_folder_missing', 'team_folder_missing']),
  })
  .strict()
export type FolderSyncHeldDeletes = z.infer<typeof FolderSyncHeldDeletesSchema>

/**
 * The engine's report as `ExecutorFolderSync.lastReport` stores it and the
 * person's status shows it. Conflict rows travel beside it, not inside.
 */
export const FolderSyncReportSchema = z
  .object({
    state: FolderSyncEngineStateSchema,
    counts: FolderSyncCountsSchema,
    lastReconcileAt: TimestampSchema.nullable(),
    heldDeletes: FolderSyncHeldDeletesSchema.nullable(),
  })
  .strict()
export type FolderSyncReport = z.infer<typeof FolderSyncReportSchema>

/**
 * The small summary that rides every heartbeat while the switch is on, so
 * Nessie's status is live between reports. `requested` is the machine's
 * switch: true asks Nessie to allow sync, false says it was turned off here.
 */
export const FolderSyncHeartbeatSummarySchema = z
  .object({
    requested: z.boolean(),
    state: FolderSyncEngineStateSchema,
    pending: z.number().int().nonnegative(),
    openConflicts: z.number().int().nonnegative(),
    heldDeletes: z.number().int().nonnegative(),
    lastReconcileAt: TimestampSchema.nullable(),
  })
  .strict()
export type FolderSyncHeartbeatSummary = z.infer<typeof FolderSyncHeartbeatSummarySchema>

/**
 * The heartbeat request with its optional `folderSync` summary. Like
 * `localMcp`, the signed payload includes the field exactly when it is
 * present, so a daemon without sync still verifies. It extends the base
 * heartbeat here rather than in `executor.ts` because this module imports
 * `executor.ts`; the heartbeat route parses with this schema.
 */
export const ExecutorDaemonHeartbeatWithFolderSyncRequestSchema = ExecutorDaemonHeartbeatRequestSchema.extend({
  folderSync: FolderSyncHeartbeatSummarySchema.optional(),
}).strict()
export type ExecutorDaemonHeartbeatWithFolderSyncRequest = z.infer<
  typeof ExecutorDaemonHeartbeatWithFolderSyncRequestSchema
>

/** Audit actions of the sync lifecycle (writes use the existing `kb.page.*`). */
export const FOLDER_SYNC_AUDIT_ACTIONS = [
  'executor.folder_sync.requested',
  'executor.folder_sync.confirmed',
  'executor.folder_sync.paused',
  'executor.folder_sync.resumed',
  'executor.folder_sync.disabled',
  'executor.folder_sync.reauthorized',
] as const
