import { z } from 'zod'

import {
  FOLDER_SYNC_MAX_FILE_BYTES,
  FOLDER_SYNC_TITLE_MAX_LENGTH,
  FolderSyncContentHashSchema,
  FolderSyncFidelitySchema,
  FolderSyncPageIdSchema,
  FolderSyncPageKindSchema,
  FolderSyncReadOnlyReasonSchema,
  FolderSyncSeqSchema,
  FolderSyncSkipReasonSchema,
  FolderSyncSpaceIdSchema,
  FolderSyncTitleSchema,
  FolderSyncVersionIdSchema,
} from './executor-folder-sync.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * What the server tells a sync client about documents: the spaces it mirrors,
 * each page with the content its file holds, and the change journal's rows.
 * Every projection is computed as the computer's owner, with their live
 * entitlements, inside the executor's paired team.
 */

/**
 * A mirrored space. Its directory name is the path mapping of `name`; the
 * owner's personal space maps to `My Documents`.
 */
export const SyncSpaceSchema = z
  .object({
    id: FolderSyncSpaceIdSchema,
    name: z.string().min(1).max(FOLDER_SYNC_TITLE_MAX_LENGTH),
    personal: z.boolean(),
    sensitivity: z.enum(['normal', 'sensitive']),
    /** `canWriteSpace` for the owner; false mirrors every page read-only. */
    writable: z.boolean(),
  })
  .strict()
export type SyncSpace = z.infer<typeof SyncSpaceSchema>

/** A readable space that is deliberately not mirrored. Ids only, never names. */
export const SyncExcludedSpaceSchema = z
  .object({
    spaceId: FolderSyncSpaceIdSchema,
    reason: FolderSyncSkipReasonSchema.extract(['restricted_space', 'agent_private_space', 'sensitive_excluded']),
  })
  .strict()
export type SyncExcludedSpace = z.infer<typeof SyncExcludedSpaceSchema>

/**
 * The content a page's file holds. `contentHash` is `sourceContentHash` for a
 * file, the SHA-256 of the rendered Markdown for a document and of the xlsx
 * rendition for a spreadsheet — the hash of the exact bytes the download
 * route serves for `versionId`.
 */
export const SyncPageHeadSchema = z
  .object({
    versionId: FolderSyncVersionIdSchema,
    contentHash: FolderSyncContentHashSchema,
    byteLength: z.number().int().nonnegative().max(FOLDER_SYNC_MAX_FILE_BYTES),
    mime: z.string().min(1).max(255),
    /** Lowercase, without the dot; null when the file has none. */
    extension: z.string().regex(/^[a-z0-9][a-z0-9._+-]{0,31}$/).nullable(),
  })
  .strict()
export type SyncPageHead = z.infer<typeof SyncPageHeadSchema>

export const SyncPageSchema = z
  .object({
    id: FolderSyncPageIdSchema,
    spaceId: FolderSyncSpaceIdSchema,
    parentPageId: FolderSyncPageIdSchema.nullable(),
    kind: FolderSyncPageKindSchema,
    title: FolderSyncTitleSchema,
    /** The page's CAS revision; every write and move is conditional on it. */
    revision: z.number().int().nonnegative(),
    /** Orders same-name siblings: the oldest keeps the plain name. */
    createdAt: TimestampSchema,
    /** Null for a folder, or when `notSyncedReason` says why there are no bytes. */
    head: SyncPageHeadSchema.nullable(),
    readOnly: z.boolean(),
    readOnlyReason: FolderSyncReadOnlyReasonSchema.nullable(),
    fidelity: FolderSyncFidelitySchema,
    notSyncedReason: FolderSyncSkipReasonSchema.extract(['version_not_disclosed', 'no_content_yet']).nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    const fail = (message: string, path: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] })
    if (page.kind === 'folder') {
      if (page.head !== null) fail('A folder has no head.', 'head')
      if (page.notSyncedReason !== null) fail('A folder is always synced.', 'notSyncedReason')
      if (page.fidelity !== 'exact') fail('A folder round-trips exactly.', 'fidelity')
    } else if ((page.head === null) === (page.notSyncedReason === null)) {
      fail('A page has a head or a reason it has none, never both.', 'head')
    }
    if (page.readOnly !== (page.readOnlyReason !== null)) {
      fail('A read-only page names its reason; a writable one has none.', 'readOnlyReason')
    }
    if ((page.kind === 'spreadsheet') !== (page.fidelity === 'oneway')) {
      fail('Exactly spreadsheets are one-way.', 'fidelity')
    }
    if (page.fidelity === 'oneway' && page.readOnlyReason !== 'spreadsheet') {
      fail('A spreadsheet is read-only as a spreadsheet.', 'readOnlyReason')
    }
    if ((page.fidelity === 'lossy') !== (page.readOnlyReason === 'document_formatting')) {
      fail('A lossy document is read-only for its formatting, and only it is.', 'readOnlyReason')
    }
    if (page.fidelity === 'lossy' && page.kind !== 'document') {
      fail('Only a document can be lossy.', 'fidelity')
    }
  })
export type SyncPage = z.infer<typeof SyncPageSchema>

/** `KnowledgeChangeJournal.kind`. */
export const FOLDER_SYNC_JOURNAL_KINDS = [
  'page_created',
  'version_created',
  'page_renamed',
  'page_moved',
  'page_archived',
  'page_restored',
  'page_published',
  'space_updated',
  'space_archived',
  'access_changed',
] as const
export const FolderSyncJournalKindSchema = z.enum(FOLDER_SYNC_JOURNAL_KINDS)
export type FolderSyncJournalKind = z.infer<typeof FolderSyncJournalKindSchema>
/** Kinds about a space as a whole; they carry no page and prompt a snapshot. */
export const FOLDER_SYNC_SPACE_JOURNAL_KINDS = ['space_updated', 'space_archived', 'access_changed'] as const

/**
 * One journal row, as the daemon receives it. `spaceId` is the page's space
 * after the change: a cross-space move is one `page_moved` row in the
 * destination space. `page_archived` and `page_restored` name the root of the
 * subtree they changed. The actor is withheld except `actorExecutorId`, the
 * writer's echo key.
 */
export const JournalRowSchema = z
  .object({
    seq: FolderSyncSeqSchema,
    spaceId: FolderSyncSpaceIdSchema,
    pageId: FolderSyncPageIdSchema.nullable(),
    kind: FolderSyncJournalKindSchema,
    versionId: FolderSyncVersionIdSchema.nullable(),
    revision: z.number().int().nonnegative().nullable(),
    parentPageId: FolderSyncPageIdSchema.nullable(),
    title: FolderSyncTitleSchema.nullable(),
    actorExecutorId: z.string().uuid().nullable(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((row, context) => {
    const spaceWide = (FOLDER_SYNC_SPACE_JOURNAL_KINDS as readonly string[]).includes(row.kind)
    if (spaceWide !== (row.pageId === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A space-wide row has no page; every other row names one.',
        path: ['pageId'],
      })
    }
    if (row.kind === 'version_created' && (row.versionId === null || row.revision === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A version row names the version and the revision it made.',
        path: ['versionId'],
      })
    }
  })
export type JournalRow = z.infer<typeof JournalRowSchema>
