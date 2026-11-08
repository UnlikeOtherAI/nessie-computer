import { z } from 'zod'

const ref = z.string().min(1).max(512)
const count = z.number().int().min(0).max(1_000_000)
export const T3CatalogPublicationSchema = z.object({
  environmentId: ref, physicalRootKey: ref, captureGeneration: ref, selectionKey: ref,
  sourceHighWater: z.string().regex(/^(0|[1-9][0-9]*)$/u).max(16), snapshotDigest: ref,
  totalPages: count, totalEntries: count, scope: z.enum(['source', 'selection']),
}).strict()
export const T3CatalogMetadataEntrySchema = z.object({
  threadId: ref, groupPath: z.array(ref).min(1).max(16), groupOrdinal: count, rowOrdinal: count,
  sourceState: z.enum(['active', 'archived', 'deleted']),
  mapping: z.object({ title: z.string().max(2048), sourceStorageKey: ref,
    sourceSchemaVersion: z.number().int().min(0).max(1_000_000), sourceMigrationRef: ref.nullable(),
    projectRef: ref.nullable(),
  }).strict(),
}).strict()
export const T3CatalogMetadataPageSchema = z.object({
  pageOrdinal: count, firstEntry: count, entries: z.array(T3CatalogMetadataEntrySchema).min(1).max(500),
}).strict()
const signed = {
  executorId: z.string().uuid(), connectionEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  observedAt: z.string().datetime(), signature: z.string().min(32).max(256),
  grantId: z.string().uuid(), publication: T3CatalogPublicationSchema,
}
export const T3CatalogPublicationExchangeSchema = z.discriminatedUnion('operation', [
  z.object({ ...signed, operation: z.literal('t3.catalog.page'), page: T3CatalogMetadataPageSchema }).strict(),
  z.object({ ...signed, operation: z.literal('t3.catalog.complete') }).strict(),
])
export type T3CatalogPublicationExchange = z.infer<typeof T3CatalogPublicationExchangeSchema>
export type T3CatalogMetadataPage = z.infer<typeof T3CatalogMetadataPageSchema>
export type T3CatalogPublication = z.infer<typeof T3CatalogPublicationSchema>
export const T3CatalogPublicationReceiptSchema = z.object({
  publicationId: z.string().uuid(), state: z.enum(['staging', 'complete', 'invalidated']),
  captureGeneration: ref, selectionKey: ref, nextPage: count, nextEntry: count, totalPages: count, totalEntries: count,
}).strict()
export type T3CatalogPublicationReceipt = z.infer<typeof T3CatalogPublicationReceiptSchema>
