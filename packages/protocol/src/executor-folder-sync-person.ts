import { z } from 'zod'

import { ExecutorIdSchema } from './executor.js'
import {
  FOLDER_SYNC_RECORD_STATUSES,
  FolderSyncContentHashSchema,
  FolderSyncCountsSchema,
  FolderSyncEngineStateSchema,
  FolderSyncHealthReasonSchema,
  FolderSyncHeldDeletesSchema,
  FolderSyncPageIdSchema,
  FolderSyncRecordStatusSchema,
  FolderSyncRelPathSchema,
  FolderSyncReportSchema,
  FolderSyncRootLabelSchema,
  FolderSyncSkipReasonSchema,
  FolderSyncSpaceIdSchema,
  FolderSyncTeamFolderSchema,
} from './executor-folder-sync.js'
import {
  ConflictReportSchema,
  FolderSyncConflictCopySchema,
  FolderSyncConflictKindSchema,
  FolderSyncConflictReasonSchema,
  FolderSyncConflictResolutionSchema,
  FolderSyncConflictStateSchema,
  FolderSyncExpectedOccurredAtSchema,
} from './executor-folder-sync-conflicts.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * What people and the native console read: the session-authenticated
 * `/api/executors/:executorId/folder-sync` routes, and the executor CLI's
 * `sync` JSON that the macOS and Windows consoles drive.
 */

// ── Person routes ──────────────────────────────────────────────────────────

/** The record's status, or why there is none to show. */
export const FolderSyncPersonStatusSchema = z.enum([
  ...FOLDER_SYNC_RECORD_STATUSES,
  /** No machine has asked yet. */
  'not_requested',
  /** A shared computer: sync is never offered. */
  'not_private',
])
export type FolderSyncPersonStatus = z.infer<typeof FolderSyncPersonStatusSchema>

/** A conflict row as Nessie lists it. */
export const FolderSyncConflictRowSchema = z
  .object({
    id: z.string().uuid(),
    clientConflictId: z.string().uuid(),
    kind: FolderSyncConflictKindSchema,
    reason: FolderSyncConflictReasonSchema,
    state: FolderSyncConflictStateSchema,
    relPath: FolderSyncRelPathSchema,
    pageId: FolderSyncPageIdSchema.nullable(),
    copy: FolderSyncConflictCopySchema.nullable(),
    occurredAt: TimestampSchema,
    createdAt: TimestampSchema,
    resolvedAt: TimestampSchema.nullable(),
    resolution: FolderSyncConflictResolutionSchema.nullable(),
  })
  .strict()
export type FolderSyncConflictRow = z.infer<typeof FolderSyncConflictRowSchema>

export const FOLDER_SYNC_CONFLICT_LIST_PAGE_SIZE = 50
export const FolderSyncConflictListSchema = z
  .object({
    items: z.array(FolderSyncConflictRowSchema).max(FOLDER_SYNC_CONFLICT_LIST_PAGE_SIZE),
    nextCursor: z.string().min(1).max(512).nullable(),
  })
  .strict()
export type FolderSyncConflictList = z.infer<typeof FolderSyncConflictListSchema>

/** `GET /api/executors/:executorId/folder-sync?conflictsCursor=…` */
export const FolderSyncStatusQuerySchema = z
  .object({ conflictsCursor: z.string().min(1).max(512).optional() })
  .strict()
export type FolderSyncStatusQuery = z.infer<typeof FolderSyncStatusQuerySchema>

/** The report without the held-delete sample, which names files. */
export const FolderSyncReportSummarySchema = FolderSyncReportSchema.omit({ heldDeletes: true })
export type FolderSyncReportSummary = z.infer<typeof FolderSyncReportSummarySchema>

/**
 * A computer's sync, for its Sync tab. `canManage` is the pairing owner, who
 * alone sees file names (conflicts, held deletes) and changes the sync;
 * `canDisable` adds organisation owners and admins, who see the status only.
 */
export const FolderSyncStatusResponseSchema = z
  .object({
    executorId: ExecutorIdSchema,
    status: FolderSyncPersonStatusSchema,
    rootLabel: FolderSyncRootLabelSchema.nullable(),
    includeSensitive: z.boolean().nullable(),
    confirmedAt: TimestampSchema.nullable(),
    lastReportAt: TimestampSchema.nullable(),
    report: FolderSyncReportSummarySchema.nullable(),
    health: z
      .object({
        reason: FolderSyncHealthReasonSchema,
        detail: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
    canManage: z.boolean(),
    canDisable: z.boolean(),
    conflicts: FolderSyncConflictListSchema.nullable(),
    heldDeletes: FolderSyncHeldDeletesSchema.nullable(),
  })
  .strict()
  .superRefine((answer, context) => {
    if (!answer.canManage && (answer.conflicts !== null || answer.heldDeletes !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only the owner sees file names.',
        path: ['canManage'],
      })
    }
  })
export type FolderSyncStatusResponse = z.infer<typeof FolderSyncStatusResponseSchema>

/** `POST …/folder-sync/confirm` — the owner allows sync on this computer. */
export const FolderSyncConfirmRequestSchema = z.object({ includeSensitive: z.boolean() }).strict()
export type FolderSyncConfirmRequest = z.infer<typeof FolderSyncConfirmRequestSchema>

/** `POST …/pause`, `…/resume`, `…/disable`, `…/reauthorize`. */
export const FolderSyncTransitionRequestSchema = z.object({}).strict()
export type FolderSyncTransitionRequest = z.infer<typeof FolderSyncTransitionRequestSchema>

/** `POST …/held-deletes/confirm` and `…/held-deletes/restore`. */
export const FolderSyncHeldDeletesDecisionRequestSchema = z.object({ batchId: z.string().uuid() }).strict()
export type FolderSyncHeldDeletesDecisionRequest = z.infer<typeof FolderSyncHeldDeletesDecisionRequestSchema>

/**
 * `POST …/conflicts/:id/resolve`. `dismiss` closes the row at once;
 * `keep_mine`/`keep_nessie` mark it `resolving` until the daemon acts.
 * `expectedOccurredAt` is the row's `occurredAt` as listed: when the daemon
 * has re-reported the row since, the server refuses with 409
 * `EXECUTOR_FOLDER_SYNC_STATE_INVALID` and the screen reloads.
 */
export const FolderSyncResolveConflictRequestSchema = z
  .object({ resolution: FolderSyncConflictResolutionSchema, expectedOccurredAt: FolderSyncExpectedOccurredAtSchema })
  .strict()
export type FolderSyncResolveConflictRequest = z.infer<typeof FolderSyncResolveConflictRequestSchema>
export const FolderSyncResolveConflictResponseSchema = z.object({ conflict: FolderSyncConflictRowSchema }).strict()
export type FolderSyncResolveConflictResponse = z.infer<typeof FolderSyncResolveConflictResponseSchema>

/** `GET /api/executors/folder-sync`: the caller's own computers in the selected team. */
export const FolderSyncComputersResponseSchema = z
  .object({
    computers: z.array(
      z
        .object({
          executorId: ExecutorIdSchema,
          name: z.string().min(1).max(255),
          status: FolderSyncRecordStatusSchema,
          openConflicts: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
export type FolderSyncComputersResponse = z.infer<typeof FolderSyncComputersResponseSchema>

/** The realtime update the executor status channel publishes. */
export const FolderSyncRealtimeUpdateSchema = z
  .object({
    type: z.literal('executor.folder_sync'),
    executorId: ExecutorIdSchema,
    status: FolderSyncPersonStatusSchema,
    openConflicts: z.number().int().nonnegative(),
  })
  .strict()
export type FolderSyncRealtimeUpdate = z.infer<typeof FolderSyncRealtimeUpdateSchema>

// ── Native console (local only) ────────────────────────────────────────────

/** A local absolute path. It never leaves the machine. */
const LocalPathSchema = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'A path has no NUL.')

/** One thing readable in Nessie that is not on disk, and why. */
export const FolderSyncNotSyncedItemSchema = z
  .object({
    relPath: FolderSyncRelPathSchema.nullable(),
    spaceId: FolderSyncSpaceIdSchema.nullable(),
    reason: FolderSyncSkipReasonSchema,
  })
  .strict()
export type FolderSyncNotSyncedItem = z.infer<typeof FolderSyncNotSyncedItemSchema>

export const FOLDER_SYNC_CONSOLE_LIST_LIMIT = 100

/**
 * What `nessie-executor sync --executor <id> status --json` prints and the
 * console's Sync tab draws, per paired team.
 */
export const FolderSyncConsoleStateSchema = z
  .object({
    executorId: ExecutorIdSchema,
    /**
     * The team folder the engine named under `root` (a file is at
     * `root/teamLabel/relPath`); null until it has. Despite the name, a path.
     */
    teamLabel: FolderSyncTeamFolderSchema.nullable(),
    /**
     * Where this team's files go under the chosen or suggested main folder:
     * the folder the engine named or, before it has, the one it will name.
     * Null while the team's names are not known yet; absent from an older CLI.
     */
    teamFolder: FolderSyncTeamFolderSchema.nullable().optional(),
    enabled: z.boolean(),
    paused: z.boolean(),
    root: LocalPathSchema.nullable(),
    /**
     * The main folder offered to a team with none chosen: the folder another
     * team on this computer already syncs into, else `~/Documents/Nessie`.
     */
    defaultRoot: LocalPathSchema,
    /** What Deleted files… opens. */
    trashPath: LocalPathSchema,
    state: FolderSyncEngineStateSchema,
    serverStatus: FolderSyncRecordStatusSchema.nullable(),
    /** Open Nessie / Allow in Nessie; null before the first handshake. */
    manageUrl: z.string().url().nullable(),
    counts: FolderSyncCountsSchema,
    activity: z
      .object({
        uploading: z.number().int().nonnegative(),
        downloading: z.number().int().nonnegative(),
      })
      .strict(),
    lastReconcileAt: TimestampSchema.nullable(),
    /** Open rows, newest first. */
    conflicts: z.array(ConflictReportSchema).max(FOLDER_SYNC_CONSOLE_LIST_LIMIT),
    heldDeletes: FolderSyncHeldDeletesSchema.nullable(),
    notSynced: z.array(FolderSyncNotSyncedItemSchema).max(FOLDER_SYNC_CONSOLE_LIST_LIMIT),
  })
  .strict()
export type FolderSyncConsoleState = z.infer<typeof FolderSyncConsoleStateSchema>

/** `describe --json`'s `folderSync` field. */
export const FolderSyncDescriptionSchema = FolderSyncConsoleStateSchema.pick({
  enabled: true,
  root: true,
  state: true,
  counts: true,
})
export type FolderSyncDescription = z.infer<typeof FolderSyncDescriptionSchema>

/**
 * The JSON the consoles pipe to `nessie-executor sync --executor <id>
 * --input-stdin`, so no path or choice travels on argv.
 */
export const FolderSyncConsoleCommandSchema = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('configure'),
      root: LocalPathSchema,
      enabled: z.boolean(),
      /** The person agreed that a non-empty folder's files go to Nessie (C22). */
      acceptExistingFiles: z.boolean(),
    })
    .strict(),
  z.object({ command: z.literal('pause'), paused: z.boolean() }).strict(),
  z
    .object({
      command: z.literal('resolve'),
      clientConflictId: z.string().uuid(),
      resolution: FolderSyncConflictResolutionSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal('held_deletes'),
      batchId: z.string().uuid(),
      decision: z.enum(['confirm', 'restore']),
    })
    .strict(),
])
export type FolderSyncConsoleCommand = z.infer<typeof FolderSyncConsoleCommandSchema>

/** Why a console command was refused; the console translates each. */
export const FOLDER_SYNC_CONSOLE_REFUSALS = [
  'root_not_absolute',
  'root_missing',
  'root_not_a_directory',
  'root_is_link',
  'root_not_writable',
  'root_overlaps_workspace_folder',
  'root_inside_state_directory',
  'root_inside_other_sync',
  'not_private',
  'conflict_not_found',
  'held_deletes_changed',
] as const
export const FolderSyncConsoleRefusalSchema = z.enum(FOLDER_SYNC_CONSOLE_REFUSALS)
export type FolderSyncConsoleRefusal = z.infer<typeof FolderSyncConsoleRefusalSchema>

export const FolderSyncConsoleCommandResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('applied'), state: FolderSyncConsoleStateSchema }).strict(),
  /** `configure` on a folder that already has files and no marker: ask first. */
  z.object({ outcome: z.literal('confirm_existing_files'), fileCount: z.number().int().positive() }).strict(),
  z.object({ outcome: z.literal('refused'), reason: FolderSyncConsoleRefusalSchema }).strict(),
])
export type FolderSyncConsoleCommandResult = z.infer<typeof FolderSyncConsoleCommandResultSchema>

/**
 * `sync verify --json`: the server snapshot as the owner, compared with the
 * folder. The acceptance gate is `missing` and `mismatched` empty.
 */
export const FolderSyncVerifyReportSchema = z
  .object({
    expected: z.number().int().nonnegative(),
    present: z.number().int().nonnegative(),
    missing: z.array(FolderSyncRelPathSchema),
    mismatched: z.array(
      z
        .object({
          relPath: FolderSyncRelPathSchema,
          expected: FolderSyncContentHashSchema,
          actual: FolderSyncContentHashSchema,
        })
        .strict(),
    ),
    extra: z.array(FolderSyncRelPathSchema),
    skipped: z.array(FolderSyncNotSyncedItemSchema),
  })
  .strict()
export type FolderSyncVerifyReport = z.infer<typeof FolderSyncVerifyReportSchema>
