import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

const UuidSchema = z.string().uuid()
const JsonRecordSchema = z.record(z.string(), z.unknown())

export const KnowledgeVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])

export const KnowledgeSensitivityTierSchema = z.enum([
  'normal',
  'sensitive',
  'restricted',
])

export const KnowledgePageStatusSchema = z.enum(['draft', 'published', 'archived'])

/**
 * A page is a rich-text document, a stored file node, a folder, or a
 * spreadsheet.
 *
 * A folder is a real kind, not a convention: it has no versions, is never
 * published and is never indexed. Before this existed a folder was a document
 * carrying `metadata.folder` (or merely having children), which meant any
 * document that gained a sub-page turned into a folder on screen, and no
 * server-side listing could exclude folders without loading a whole space.
 *
 * A spreadsheet is a live IronCalc workbook: the grid *is* the document, its
 * edits are a journal of operation batches rather than whole-body versions, and
 * its xlsx is only a rendition an export or a version download serves. It is
 * never a file node that happens to be named `.xlsx`.
 *
 * Adding a value here is a breaking change for every exhaustive branch over it
 * — deliberately: indexing status, the row icon and Get Info must each say what
 * the new kind does rather than silently reading as a document.
 */
export const KnowledgePageKindSchema = z.enum(['document', 'file', 'spreadsheet', 'folder', 'package'])
export type KnowledgePageKind = z.infer<typeof KnowledgePageKindSchema>

/**
 * The knowledge-space shape returned to browser clients. Keeping this in the
 * shared contract package makes a server/client field mismatch a type error
 * instead of a silently undefined UI capability.
 */
export const KnowledgeSpaceResponseSchema = z.object({
  id: UuidSchema,
  ownerAgentId: UuidSchema.nullable(),
  name: NonEmptyStringSchema,
  description: z.string().nullable(),
  metadata: JsonRecordSchema.nullable(),
  writeRestricted: z.boolean(),
  memberUserIds: z.array(UuidSchema),
  memberAgentIds: z.array(UuidSchema),
  // Effective verdicts for the requesting actor. Writing content and
  // administering the space's access list are deliberately separate powers.
  canWrite: z.boolean(),
  canManageAccess: z.boolean(),
  organizationId: UuidSchema,
  projectId: UuidSchema,
  teamId: UuidSchema.nullable().optional(),
  channelId: UuidSchema.nullable().optional(),
  threadId: UuidSchema.nullable().optional(),
  userId: UuidSchema.nullable().optional(),
  visibility: KnowledgeVisibilitySchema,
  sensitivityTier: KnowledgeSensitivityTierSchema,
  privateToAgentId: UuidSchema.nullable().optional(),
  createdBy: NonEmptyStringSchema,
  deletedAt: z.string().nullable(),
  sourceRef: NonEmptyStringSchema,
  visibilityReason: NonEmptyStringSchema,
  policyChainTrace: z.array(z.string()),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
})
export type KnowledgeSpaceResponse = z.infer<typeof KnowledgeSpaceResponseSchema>
