import { z } from 'zod'

import {
  ExecutorDaemonSignatureSchema,
  ExecutorIdSchema,
} from './executor.js'
import {
  FOLDER_SYNC_CHANGES_PAGE_SIZE,
  FOLDER_SYNC_MARKDOWN_MAX_BYTES,
  FOLDER_SYNC_MAX_FILE_BYTES,
  FOLDER_SYNC_MAX_PARTS,
  FOLDER_SYNC_PART_BYTES,
  FOLDER_SYNC_REPORT_LIMITS,
  FOLDER_SYNC_SNAPSHOT_PAGE_SIZE,
  FolderSyncChangeCommentSchema,
  FolderSyncContentHashSchema,
  FolderSyncCursorsSchema,
  FolderSyncMarkdownSchema,
  FolderSyncPageIdSchema,
  FolderSyncRecordStatusSchema,
  FolderSyncReportSchema,
  FolderSyncRootLabelSchema,
  FolderSyncSeqSchema,
  FolderSyncSpaceIdSchema,
  FolderSyncTitleSchema,
  FolderSyncVersionIdSchema,
} from './executor-folder-sync.js'
import {
  JournalRowSchema,
  SyncExcludedSpaceSchema,
  SyncPageSchema,
  SyncSpaceSchema,
} from './executor-folder-sync-projections.js'
import {
  ConflictReportSchema,
  FolderSyncConflictResolutionSchema,
  FolderSyncExpectedOccurredAtSchema,
} from './executor-folder-sync-conflicts.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * The daemon's sync wire: `/api/executor-daemon/sync/*`.
 *
 * Every JSON body is signed under `EXECUTOR_FOLDER_SYNC_SIGNATURE_DOMAIN`;
 * the signed payload is the body without `signature`, canonicalised by
 * `canonicalExecutorJson`. Path parameters are repeated in the body so the
 * signature binds them, and the server refuses a body whose ids differ from
 * the path. The two byte routes carry the same envelope in a header instead.
 */

export const FOLDER_SYNC_OPERATIONS = [
  'handshake',
  'snapshot',
  'changes',
  'download',
  'create_page',
  'write_document',
  'upload_begin',
  'upload_part',
  'upload_complete',
  'move',
  'archive',
  'report',
] as const
export const FolderSyncOperationSchema = z.enum(FOLDER_SYNC_OPERATIONS)
export type FolderSyncOperation = z.infer<typeof FolderSyncOperationSchema>

const envelopeShape = {
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
}

const signedRequest = <TOperation extends FolderSyncOperation, TShape extends z.ZodRawShape>(
  operation: TOperation,
  shape: TShape,
) => z.object({
  ...envelopeShape,
  operation: z.literal(operation),
  signature: ExecutorDaemonSignatureSchema,
  ...shape,
}).strict()

const BaseRevisionSchema = z.number().int().nonnegative()
const PageKeySchema = z.string().uuid()
/**
 * The operation receipt key of a write (`write_document`, a `new_version`
 * upload, `move`, `archive`): minted once when the action is planned and
 * reused by every retry of it. The server answers a known key with the
 * original result, or `EXECUTOR_FOLDER_SYNC_OPERATION_MISMATCH` when the
 * request differs. Required on `move`; optional on the other three only so
 * earlier bodies parse — the daemon always sends it and the server requires it.
 */
export const FolderSyncOperationKeySchema = z.string().uuid()

// ── Header envelope (byte routes) ──────────────────────────────────────────

/** The canonical JSON of the envelope (`canonicalExecutorJson`). */
export const EXECUTOR_FOLDER_SYNC_ENVELOPE_HEADER = 'x-nessie-executor-sync'
/** The envelope's signature, under the sync domain. */
export const EXECUTOR_FOLDER_SYNC_SIGNATURE_HEADER = 'x-nessie-executor-signature'
export const FOLDER_SYNC_ENVELOPE_HEADER_MAX_BYTES = 2048

const byteEnvelope = <TOperation extends FolderSyncOperation, TShape extends z.ZodRawShape>(
  operation: TOperation,
  shape: TShape,
) => z.object({ ...envelopeShape, operation: z.literal(operation), ...shape }).strict()

/** `GET …/sync/pages/:pageId/versions/:versionId/bytes`; `Range` is honoured. */
export const FolderSyncDownloadEnvelopeSchema = byteEnvelope('download', {
  pageId: FolderSyncPageIdSchema,
  versionId: FolderSyncVersionIdSchema,
})
export type FolderSyncDownloadEnvelope = z.infer<typeof FolderSyncDownloadEnvelopeSchema>

/** `PUT …/sync/uploads/:uploadId/parts/:partNumber`; the body is the raw part. */
export const FolderSyncUploadPartEnvelopeSchema = byteEnvelope('upload_part', {
  uploadId: z.string().uuid(),
  /** 1-based, as in S3 multipart. */
  partNumber: z.number().int().min(1).max(FOLDER_SYNC_MAX_PARTS),
  byteLength: z.number().int().nonnegative().max(FOLDER_SYNC_PART_BYTES),
  digest: FolderSyncContentHashSchema,
})
export type FolderSyncUploadPartEnvelope = z.infer<typeof FolderSyncUploadPartEnvelopeSchema>

export const FolderSyncByteEnvelopeSchema = z.discriminatedUnion('operation', [
  FolderSyncDownloadEnvelopeSchema,
  FolderSyncUploadPartEnvelopeSchema,
])
export type FolderSyncByteEnvelope = z.infer<typeof FolderSyncByteEnvelopeSchema>

/** A download's `ETag`: the version and the hash of the bytes served. */
export const folderSyncDownloadEtag = (versionId: string, contentHash: string): string =>
  `"${versionId}-${contentHash}"`

/** How many parts an upload of `byteLength` bytes has; an empty file has one. */
export const folderSyncPartCount = (byteLength: number): number =>
  Math.max(1, Math.ceil(byteLength / FOLDER_SYNC_PART_BYTES))

/** The exact size of part `partNumber` (1-based) of a `byteLength` upload. */
export const folderSyncPartByteLength = (byteLength: number, partNumber: number): number => {
  const count = folderSyncPartCount(byteLength)
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) {
    throw new RangeError(`Part ${partNumber} is outside 1..${count}.`)
  }
  return partNumber < count ? FOLDER_SYNC_PART_BYTES : byteLength - (count - 1) * FOLDER_SYNC_PART_BYTES
}

// ── Handshake ──────────────────────────────────────────────────────────────

/** The only path that creates the sync row (as `requested`). */
export const FolderSyncHandshakeRequestSchema = signedRequest('handshake', {
  requested: z
    .object({
      rootLabel: FolderSyncRootLabelSchema,
      includeSensitive: z.boolean(),
    })
    .strict(),
  /**
   * The daemon reads `organizationName` in the answer. Earlier daemons parse
   * the answer strictly, so Nessie sends that field only when asked. Ship
   * order: Nessie accepts this field before any daemon sends it.
   */
  wantsOrganizationName: z.literal(true).optional(),
})
export type FolderSyncHandshakeRequest = z.infer<typeof FolderSyncHandshakeRequestSchema>

export const FolderSyncHandshakeResponseSchema = z
  .object({
    status: FolderSyncRecordStatusSchema,
    /** The team's display name; the client maps it to the team folder. */
    teamLabel: z.string().min(1).max(255),
    /**
     * The team's organisation's display name, sent only when the request has
     * `wantsOrganizationName`. A new team folder is `<organisation>/<team>`;
     * without it the computer reads the name from its pairing claim.
     */
    organizationName: z.string().min(1).max(255).optional(),
    /**
     * This computer's name as Nessie shows it; the client names conflicted
     * copies and change comments with it, never with the host name.
     */
    computerLabel: z.string().min(1).max(255),
    /** Effective: false when the organisation locks sensitive spaces out. */
    includeSensitive: z.boolean(),
    /** The admin's Sync tab for this computer — the console's Open Nessie. */
    manageUrl: z.string().url(),
    limits: z
      .object({
        maxUploadBytes: z.number().int().positive().max(FOLDER_SYNC_MAX_FILE_BYTES),
        partBytes: z.literal(FOLDER_SYNC_PART_BYTES),
        markdownMaxBytes: z.literal(FOLDER_SYNC_MARKDOWN_MAX_BYTES),
      })
      .strict(),
    /** A cursor below this sequence has been pruned: take a snapshot. */
    retentionFloorSeq: FolderSyncSeqSchema,
  })
  .strict()
export type FolderSyncHandshakeResponse = z.infer<typeof FolderSyncHandshakeResponseSchema>

// ── Snapshot and changes ───────────────────────────────────────────────────

const SnapshotCursorSchema = z.string().min(1).max(2048)

export const FolderSyncSnapshotRequestSchema = signedRequest('snapshot', {
  /** Null starts a snapshot; otherwise the previous page's `nextCursor`. */
  cursor: SnapshotCursorSchema.nullable(),
})
export type FolderSyncSnapshotRequest = z.infer<typeof FolderSyncSnapshotRequestSchema>

/**
 * One page of a snapshot. `cursors` are the journal positions read before the
 * listing began — the same on every page — so changes pulled from them
 * replay anything that happened while the snapshot was paged.
 */
export const FolderSyncSnapshotResponseSchema = z
  .object({
    spaces: z.array(SyncSpaceSchema),
    excludedSpaces: z.array(SyncExcludedSpaceSchema),
    pages: z.array(SyncPageSchema).max(FOLDER_SYNC_SNAPSHOT_PAGE_SIZE),
    cursors: FolderSyncCursorsSchema,
    nextCursor: SnapshotCursorSchema.nullable(),
  })
  .strict()
export type FolderSyncSnapshotResponse = z.infer<typeof FolderSyncSnapshotResponseSchema>

export const FolderSyncChangesRequestSchema = signedRequest('changes', {
  cursors: FolderSyncCursorsSchema,
  /** Long-poll up to `FOLDER_SYNC_TIMING.longPollMs` when nothing is new. */
  wait: z.boolean(),
})
export type FolderSyncChangesRequest = z.infer<typeof FolderSyncChangesRequestSchema>

/**
 * Journal rows after the cursors, and the current truth of every page they
 * name: each named page is in `pages` (readable now, as the owner) or in
 * `gonePageIds` (archived, moved out of reach, or access lost).
 */
export const FolderSyncChangesResponseSchema = z
  .object({
    changes: z.array(JournalRowSchema).max(FOLDER_SYNC_CHANGES_PAGE_SIZE),
    pages: z.array(SyncPageSchema).max(FOLDER_SYNC_CHANGES_PAGE_SIZE),
    gonePageIds: z.array(FolderSyncPageIdSchema).max(FOLDER_SYNC_CHANGES_PAGE_SIZE),
    cursors: FolderSyncCursorsSchema,
    /** More rows are waiting: pull again at once. */
    hasMore: z.boolean(),
    /** A space was added, renamed, archived or its access changed: snapshot. */
    spacesChanged: z.boolean(),
    /** Spaces whose cursor fell below retention: snapshot them. */
    cursorExpired: z.array(FolderSyncSpaceIdSchema),
  })
  .strict()
  .superRefine((answer, context) => {
    const present = new Set(answer.pages.map((page) => page.id))
    const gone = new Set(answer.gonePageIds)
    for (const pageId of present) {
      if (gone.has(pageId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Page ${pageId} is both present and gone.`, path: ['gonePageIds'] })
      }
    }
    for (const row of answer.changes) {
      if (row.pageId !== null && !present.has(row.pageId) && !gone.has(row.pageId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Page ${row.pageId} is named but not described.`, path: ['pages'] })
      }
    }
  })
export type FolderSyncChangesResponse = z.infer<typeof FolderSyncChangesResponseSchema>

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * What a write did, decided by hash on the server:
 * - `written` — a new version (or a move) was stored.
 * - `already_current` — the bytes equal the head's; nothing was stored.
 * - `remote_only` — the bytes equal the base's while the head moved on;
 *   nothing was stored and the client downloads the head (no 409).
 * - `created` — a page was created (`create_page`, a `new_page` upload).
 * A receipt replay answers the original outcome.
 */
export const FOLDER_SYNC_WRITE_OUTCOMES = ['written', 'already_current', 'remote_only', 'created'] as const
export const FolderSyncWriteOutcomeSchema = z.enum(FOLDER_SYNC_WRITE_OUTCOMES)
export type FolderSyncWriteOutcome = z.infer<typeof FolderSyncWriteOutcomeSchema>

/** Every write answers with what it did and the page as it now is. */
export const FolderSyncPageResponseSchema = z
  .object({ outcome: FolderSyncWriteOutcomeSchema, page: SyncPageSchema })
  .strict()
export type FolderSyncPageResponse = z.infer<typeof FolderSyncPageResponseSchema>

/**
 * Why a write lost its base:
 * - `base_unknown` — `baseVersionId` is not a version of this page (it was
 *   collapsed, or never was); the client keeps its bytes and takes R2.
 * - `head_changed` — a content or placement write moved the revision on.
 * - `lifecycle_changed` — an archive, restore or publish moved it on.
 * - `subtree_changed` — an archive's descendants or their revisions no longer match the
 *   live descendants.
 */
export const FOLDER_SYNC_CONFLICT_ERROR_REASONS = [
  'base_unknown',
  'head_changed',
  'lifecycle_changed',
  'subtree_changed',
] as const
export const FolderSyncConflictErrorReasonSchema = z.enum(FOLDER_SYNC_CONFLICT_ERROR_REASONS)
export type FolderSyncConflictErrorReason = z.infer<typeof FolderSyncConflictErrorReasonSchema>

/** The `details` of a 409 `EXECUTOR_FOLDER_SYNC_CONFLICT`: the head that won, and why. */
export const FolderSyncConflictErrorDetailsSchema = z
  .object({ page: SyncPageSchema, reason: FolderSyncConflictErrorReasonSchema })
  .strict()
export type FolderSyncConflictErrorDetails = z.infer<typeof FolderSyncConflictErrorDetailsSchema>

const createShape = {
  /** The creation receipt key: a retry never creates twice. */
  pageKey: PageKeySchema,
  spaceId: FolderSyncSpaceIdSchema,
  parentPageId: FolderSyncPageIdSchema.nullable(),
  title: FolderSyncTitleSchema,
}

/**
 * `POST …/sync/pages`: a folder or a document. A file page is created by
 * completing an upload whose intent is `new_page`.
 */
export const FolderSyncCreatePageRequestSchema = z.discriminatedUnion('kind', [
  signedRequest('create_page', { ...createShape, kind: z.literal('folder') }),
  signedRequest('create_page', { ...createShape, kind: z.literal('document'), markdown: FolderSyncMarkdownSchema }),
])
export type FolderSyncCreatePageRequest = z.infer<typeof FolderSyncCreatePageRequestSchema>

/**
 * `POST …/sync/pages/:pageId/document`. The answer's `head.contentHash` is
 * the server's rendering of what was stored; when it differs from the hash of
 * the uploaded Markdown the client rewrites the file with that rendering
 * (only if the file is still what it uploaded), so the two sides converge.
 */
export const FolderSyncWriteDocumentRequestSchema = signedRequest('write_document', {
  operationKey: FolderSyncOperationKeySchema.optional(),
  pageId: FolderSyncPageIdSchema,
  baseRevision: BaseRevisionSchema,
  baseVersionId: FolderSyncVersionIdSchema.nullable(),
  markdown: FolderSyncMarkdownSchema,
  changeComment: FolderSyncChangeCommentSchema,
})
export type FolderSyncWriteDocumentRequest = z.infer<typeof FolderSyncWriteDocumentRequestSchema>

export const FolderSyncUploadIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new_page'), ...createShape }).strict(),
  z
    .object({
      kind: z.literal('new_version'),
      operationKey: FolderSyncOperationKeySchema.optional(),
      pageId: FolderSyncPageIdSchema,
      baseRevision: BaseRevisionSchema,
      baseVersionId: FolderSyncVersionIdSchema.nullable(),
      changeComment: FolderSyncChangeCommentSchema,
    })
    .strict(),
])
export type FolderSyncUploadIntent = z.infer<typeof FolderSyncUploadIntentSchema>

/** `POST …/sync/uploads`. Idempotent by `sessionKey`: a retry resumes. */
export const FolderSyncUploadBeginRequestSchema = signedRequest('upload_begin', {
  sessionKey: z.string().uuid(),
  intent: FolderSyncUploadIntentSchema,
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
  byteLength: z.number().int().nonnegative().max(FOLDER_SYNC_MAX_FILE_BYTES),
  digest: FolderSyncContentHashSchema,
  partCount: z.number().int().min(1).max(FOLDER_SYNC_MAX_PARTS),
}).superRefine((request, context) => {
  if (request.partCount !== folderSyncPartCount(request.byteLength)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${request.byteLength} bytes is ${folderSyncPartCount(request.byteLength)} parts.`,
      path: ['partCount'],
    })
  }
})
export type FolderSyncUploadBeginRequest = z.infer<typeof FolderSyncUploadBeginRequestSchema>

const PartsReceivedSchema = z.array(z.number().int().min(1).max(FOLDER_SYNC_MAX_PARTS)).max(FOLDER_SYNC_MAX_PARTS)

export const FolderSyncUploadBeginResponseSchema = z
  .object({
    uploadId: z.string().uuid(),
    partCount: z.number().int().min(1).max(FOLDER_SYNC_MAX_PARTS),
    /** Parts already stored — empty for a new session. */
    partsReceived: PartsReceivedSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
export type FolderSyncUploadBeginResponse = z.infer<typeof FolderSyncUploadBeginResponseSchema>

export const FolderSyncUploadPartResponseSchema = z.object({ partsReceived: PartsReceivedSchema }).strict()
export type FolderSyncUploadPartResponse = z.infer<typeof FolderSyncUploadPartResponseSchema>

/** `POST …/sync/uploads/:uploadId/complete` → `FolderSyncPageResponse` or 409. */
export const FolderSyncUploadCompleteRequestSchema = signedRequest('upload_complete', {
  uploadId: z.string().uuid(),
})
export type FolderSyncUploadCompleteRequest = z.infer<typeof FolderSyncUploadCompleteRequestSchema>

/** `POST …/sync/pages/:pageId/move`: parent, space and title in one write. */
export const FolderSyncMoveRequestSchema = signedRequest('move', {
  operationKey: FolderSyncOperationKeySchema,
  pageId: FolderSyncPageIdSchema,
  baseRevision: BaseRevisionSchema,
  spaceId: FolderSyncSpaceIdSchema,
  parentPageId: FolderSyncPageIdSchema.nullable(),
  title: FolderSyncTitleSchema,
})
export type FolderSyncMoveRequest = z.infer<typeof FolderSyncMoveRequestSchema>

/** `POST …/sync/pages/:pageId/archive`: archived without purging its bytes. */
export const FolderSyncArchiveRequestSchema = signedRequest('archive', {
  operationKey: FolderSyncOperationKeySchema.optional(),
  pageId: FolderSyncPageIdSchema,
  baseRevision: BaseRevisionSchema,
  /**
   * The live descendants the plan saw — the pages the mirror shows below it.
   * The server refuses an archive that would reach a page the mirror does not
   * show, and counts the rest under the tree lock (409 `subtree_changed` on a
   * difference). Required: without it an archive could take pages no
   * computer ever showed.
   */
  descendantCount: z.number().int().nonnegative(),
  /** Binds every descendant's revision to the observed plan, including content edits. */
  descendantHash: FolderSyncContentHashSchema,
  /** Set when a person released this delete from a held batch (audited). */
  heldDeleteBatchId: z.string().uuid().nullable(),
})
export type FolderSyncArchiveRequest = z.infer<typeof FolderSyncArchiveRequestSchema>

export const FolderSyncArchiveResponseSchema = z
  .object({ archivedPageIds: z.array(FolderSyncPageIdSchema).min(1) })
  .strict()
export type FolderSyncArchiveResponse = z.infer<typeof FolderSyncArchiveResponseSchema>

// ── Report ─────────────────────────────────────────────────────────────────

export const FolderSyncResolvedConflictSchema = z
  .object({
    clientConflictId: z.string().uuid(),
    resolution: FolderSyncConflictResolutionSchema,
  })
  .strict()
export type FolderSyncResolvedConflict = z.infer<typeof FolderSyncResolvedConflictSchema>

/**
 * `POST …/sync/report`: the stored report plus conflict rows and resolutions.
 * Accepted in every status; the answer's `status` tells the daemon to pause,
 * stop (`disabled`) or wait for reauthorization.
 */
export const FolderSyncReportRequestSchema = signedRequest('report', {
  ...FolderSyncReportSchema.shape,
  /** New or changed rows, upserted by `clientConflictId`. */
  conflicts: z.array(ConflictReportSchema).max(FOLDER_SYNC_REPORT_LIMITS.conflicts),
  resolved: z.array(FolderSyncResolvedConflictSchema).max(FOLDER_SYNC_REPORT_LIMITS.resolved),
})
export type FolderSyncReportRequest = z.infer<typeof FolderSyncReportRequestSchema>

/**
 * What the person decided in Nessie, for the daemon to carry out. A held-
 * deletes decision applies only while the daemon's held set is still
 * `batchId`; a conflict choice closes the row once the daemon reports it.
 */
export const FolderSyncReportResponseSchema = z
  .object({
    status: FolderSyncRecordStatusSchema,
    instructions: z
      .object({
        heldDeletes: z
          .object({ batchId: z.string().uuid(), decision: z.enum(['confirm', 'restore']) })
          .strict()
          .nullable(),
        resolveConflicts: z.array(
          z
            .object({
              clientConflictId: z.string().uuid(),
              resolution: FolderSyncConflictResolutionSchema.exclude(['dismiss']),
              /**
               * The row's `occurredAt` the person saw. The daemon applies the
               * choice only while it, the head version and the copy hash
               * still match; otherwise it re-reports the row as `open`.
               * Optional only so earlier answers parse; the server always sends it.
               */
              expectedOccurredAt: FolderSyncExpectedOccurredAtSchema.optional(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
export type FolderSyncReportResponse = z.infer<typeof FolderSyncReportResponseSchema>
