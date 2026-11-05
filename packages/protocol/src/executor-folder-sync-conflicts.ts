import { z } from 'zod'

import {
  FolderSyncContentHashSchema,
  FolderSyncPageIdSchema,
  FolderSyncRelPathSchema,
  FolderSyncVersionIdSchema,
} from './executor-folder-sync.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * What a conflict row is, decided by its reason:
 * - `conflicted_copy` — both sides changed; a second copy now exists (R2).
 * - `quarantined` — a local edit was kept beside the file, not uploaded (R1).
 * - `info` — sync settled it; the person is told once (R4, R6, C14, C17).
 * - `error` — the item cannot sync until something changes (C15, C18, C20).
 */
export const FOLDER_SYNC_CONFLICT_KINDS = ['conflicted_copy', 'quarantined', 'info', 'error'] as const
export const FolderSyncConflictKindSchema = z.enum(FOLDER_SYNC_CONFLICT_KINDS)
export type FolderSyncConflictKind = z.infer<typeof FolderSyncConflictKindSchema>

/**
 * The closed set of reason codes a conflict row carries. The admin and the
 * console translate each one; adding a code is adding a translation in every
 * locale. Each code's kind is fixed by `FOLDER_SYNC_CONFLICT_REASON_KIND`.
 */
export const FOLDER_SYNC_CONFLICT_REASONS = [
  'edited_on_both_sides',
  'created_on_both_sides',
  'deleted_in_nessie_edit_kept',
  'deleted_here_restored',
  'folder_deleted_here_child_restored',
  'folder_deleted_in_nessie_child_recreated',
  'renamed_in_nessie',
  'moved_to_other_space',
  'type_changed',
  'read_only_document_formatting',
  'read_only_spreadsheet',
  'read_only_published',
  'read_only_no_write_access',
  'access_removed',
  'access_removed_edit_kept',
  'too_large',
  'storage_full',
  'link_not_synced',
  'file_in_use',
  'name_not_supported',
] as const
export const FolderSyncConflictReasonSchema = z.enum(FOLDER_SYNC_CONFLICT_REASONS)
export type FolderSyncConflictReason = z.infer<typeof FolderSyncConflictReasonSchema>

export const FOLDER_SYNC_CONFLICT_REASON_KIND: Readonly<Record<FolderSyncConflictReason, FolderSyncConflictKind>> = {
  edited_on_both_sides: 'conflicted_copy',
  created_on_both_sides: 'conflicted_copy',
  deleted_in_nessie_edit_kept: 'info',
  deleted_here_restored: 'info',
  folder_deleted_here_child_restored: 'info',
  folder_deleted_in_nessie_child_recreated: 'info',
  renamed_in_nessie: 'info',
  moved_to_other_space: 'info',
  type_changed: 'info',
  read_only_document_formatting: 'quarantined',
  read_only_spreadsheet: 'quarantined',
  read_only_published: 'quarantined',
  read_only_no_write_access: 'quarantined',
  access_removed: 'info',
  access_removed_edit_kept: 'quarantined',
  too_large: 'error',
  storage_full: 'error',
  link_not_synced: 'info',
  file_in_use: 'error',
  name_not_supported: 'error',
}

/** The cases and rules of the conflict matrix (`docs/standards/folder-sync.md`). */
export const FOLDER_SYNC_MATRIX_CASES = [
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10',
  'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20',
  'C21', 'C22', 'C23', 'C24', 'C25', 'C26', 'C27', 'C28', 'C29', 'C30',
  'C31', 'C32', 'C33', 'C34', 'C35', 'C36',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
] as const
export type FolderSyncMatrixCase = (typeof FOLDER_SYNC_MATRIX_CASES)[number]

/**
 * Which reason codes each matrix case may leave on a conflict row. An empty
 * list is a deliberate statement that the case leaves no row: it converges
 * silently (C9, C10, C16, C25–C27, R3, R5), is shown as an engine state
 * (C19 `disk_full`, C21 `root_missing`), is asked before it happens (C22), or
 * is the held-deletes block rather than a row (C23). C28–C31 and C33–C36
 * converge through operation receipts, generation-aware acknowledgements,
 * the revision guard and the hash outcomes; C32 re-reports its row as C1.
 * R7 governs every row.
 * The simulator asserts each case against this table.
 */
export const FOLDER_SYNC_CASE_REASONS: Readonly<Record<FolderSyncMatrixCase, readonly FolderSyncConflictReason[]>> = {
  C1: ['edited_on_both_sides'],
  C2: ['deleted_in_nessie_edit_kept'],
  C3: ['deleted_here_restored'],
  C4: ['renamed_in_nessie'],
  C5: ['folder_deleted_here_child_restored', 'folder_deleted_in_nessie_child_recreated'],
  C6: ['created_on_both_sides'],
  C7: ['type_changed'],
  C8: ['edited_on_both_sides', 'deleted_in_nessie_edit_kept', 'renamed_in_nessie'],
  C9: [],
  C10: [],
  C11: ['edited_on_both_sides'],
  C12: ['file_in_use'],
  C13: [
    'read_only_document_formatting',
    'read_only_spreadsheet',
    'read_only_published',
    'read_only_no_write_access',
  ],
  C14: ['access_removed', 'access_removed_edit_kept'],
  C15: ['too_large', 'storage_full'],
  C16: [],
  C17: ['link_not_synced'],
  C18: ['file_in_use'],
  C19: [],
  C20: ['name_not_supported'],
  C21: [],
  C22: [],
  C23: [],
  C24: ['edited_on_both_sides'],
  C25: [],
  C26: [],
  C27: [],
  C28: [],
  C29: [],
  C30: [],
  C31: [],
  C32: ['edited_on_both_sides'],
  C33: [],
  C34: [],
  C35: [],
  C36: [],
  R1: [
    'read_only_document_formatting',
    'read_only_spreadsheet',
    'read_only_published',
    'read_only_no_write_access',
    'access_removed_edit_kept',
  ],
  R2: ['edited_on_both_sides', 'created_on_both_sides'],
  R3: [],
  R4: [
    'deleted_in_nessie_edit_kept',
    'deleted_here_restored',
    'folder_deleted_here_child_restored',
    'folder_deleted_in_nessie_child_recreated',
  ],
  R5: [],
  R6: ['renamed_in_nessie', 'moved_to_other_space', 'type_changed'],
  R7: [],
}

/**
 * How a row is closed. `keep_mine` and `keep_nessie` act on files, so the
 * daemon performs them (from the console directly, or relayed from Nessie in
 * a report answer); `dismiss` only acknowledges and leaves both copies.
 */
export const FolderSyncConflictResolutionSchema = z.enum(['keep_mine', 'keep_nessie', 'dismiss'])
export type FolderSyncConflictResolution = z.infer<typeof FolderSyncConflictResolutionSchema>

/**
 * A row's `occurredAt` named back by a resolution, compared as an instant.
 * An ISO 8601 timestamp, so a value that is not one is refused, not mismatched.
 */
export const FolderSyncExpectedOccurredAtSchema = z.string().datetime({ offset: true })

/** `open` → (`resolving` while a Nessie choice waits for the daemon) → `resolved`. */
export const FolderSyncConflictStateSchema = z.enum(['open', 'resolving', 'resolved'])
export type FolderSyncConflictState = z.infer<typeof FolderSyncConflictStateSchema>

/** The second copy a conflicted copy or quarantine made. */
export const FolderSyncConflictCopySchema = z
  .object({
    relPath: FolderSyncRelPathSchema,
    /** The sibling page R2 created in Nessie; null for a local-only copy. */
    pageId: FolderSyncPageIdSchema.nullable(),
    /**
     * The copy's bytes when the row was reported. A resolution applies only
     * while the copy still hashes to this; otherwise the row is re-reported.
     * Optional on the wire only so rows reported before it existed parse;
     * the daemon always sends it.
     */
    contentHash: FolderSyncContentHashSchema.optional(),
  })
  .strict()
export type FolderSyncConflictCopy = z.infer<typeof FolderSyncConflictCopySchema>

/**
 * One conflict as the daemon reports it, upserted by
 * `(executorId, clientConflictId)`. The kind follows from the reason.
 * `occurredAt` is the row's version: a re-report after drift carries a new
 * one, and a person's resolution names the one it saw (`expectedOccurredAt`).
 */
export const ConflictReportSchema = z
  .object({
    clientConflictId: z.string().uuid(),
    kind: FolderSyncConflictKindSchema,
    reason: FolderSyncConflictReasonSchema,
    relPath: FolderSyncRelPathSchema,
    pageId: FolderSyncPageIdSchema.nullable(),
    copy: FolderSyncConflictCopySchema.nullable(),
    occurredAt: TimestampSchema,
    /**
     * Nessie's head version the row was decided against; null when the page
     * had none. A resolution applies only while the head is still this one.
     * Optional on the wire only so earlier rows parse; the daemon always sends it.
     */
    headVersionId: FolderSyncVersionIdSchema.nullable().optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (FOLDER_SYNC_CONFLICT_REASON_KIND[report.reason] !== report.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Reason ${report.reason} is a ${FOLDER_SYNC_CONFLICT_REASON_KIND[report.reason]} row.`,
        path: ['kind'],
      })
    }
    // A quarantine names the copy beside the file, or none when the kept edit
    // went to Deleted files (C14: the folder copy itself had to go).
    const copyRule = report.kind === 'conflicted_copy'
      ? report.copy !== null
      : report.kind === 'quarantined' || report.copy === null
    if (!copyRule) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A conflicted copy names its copy; info and error rows have none.',
        path: ['copy'],
      })
    }
  })
export type ConflictReport = z.infer<typeof ConflictReportSchema>
