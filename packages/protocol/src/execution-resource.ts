import { z } from 'zod'
import { T3ExecutionCustodySchema } from './t3-session/native-execution.js'

const id = z.string().min(1).max(256).refine(value => new TextEncoder().encode(value).length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value))
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
export const T3_EXECUTION_SETTINGS_LIMIT = 1024 * 1024
/** Metadata only. Parsing this descriptor does not issue a resource or consent. */
export const T3ExecutionSourceResourceSchema = z.object({
  executorId: id, admittedRootKey: id, physicalRootKey: z.string().regex(/^windows-file-id:[a-f0-9]{64}$/u),
  environmentId: id, databaseIdentity: id, environmentIdentity: id,
  layout: z.enum(['v2-80', 'legacy-54']), databaseRole: z.enum(['authoritative-v2', 'sole-legacy']),
}).strict().refine(source => source.databaseRole === (source.layout === 'v2-80' ? 'authoritative-v2' : 'sole-legacy'))
export const T3ExecutionProviderResourceSchema = z.object({
  referenceId: hex, instanceId: id, driver: z.enum(['codex', 'claude']),
  role: z.enum(['continuation', 'history', 'credential']), identity: id,
}).strict()
export const T3ExecutionResourceReceiptSchema = z.object({
  version: z.literal(1), resourceId: hex, resourceGeneration: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  evidence: z.object({
    source: T3ExecutionSourceResourceSchema, settingsIdentity: id, settingsDigest: hex,
    settingsLength: z.number().int().min(1).max(T3_EXECUTION_SETTINGS_LIMIT),
    providerReferences: z.array(T3ExecutionProviderResourceSchema).max(192)
      .refine(refs => new Set(refs.map(ref => ref.referenceId)).size === refs.length
        && new Set(refs.map(ref => `${ref.instanceId}:${ref.role}`)).size === refs.length),
  }).strict(),
  custody: T3ExecutionCustodySchema,
}).strict()
export type T3ExecutionResourceReceipt = z.infer<typeof T3ExecutionResourceReceiptSchema>
export type T3ExecutionProviderResource = z.infer<typeof T3ExecutionProviderResourceSchema>

/** Local native storage metadata only; neither schema creates custody or a grant. */
export const T3ExecutionDestinationReceiptSchema = z.object({
  version: z.literal(1), resourceId: hex, resourceGeneration: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  runtimeGeneration: z.string().regex(/^destination-sha256:[a-f0-9]{64}$/u), directoryIdentity: id, writerIdentity: id,
}).strict()
export const T3ExecutionDestinationFileReceiptSchema = z.object({
  version: z.literal(1), runtimeGeneration: z.string().regex(/^destination-sha256:[a-f0-9]{64}$/u),
  reference: z.union([z.literal('journal'), z.string().regex(/^t3-capture:v1:[a-f0-9]{64}$/u)]), databaseIdentity: id,
}).strict()
export type T3ExecutionDestinationReceipt = z.infer<typeof T3ExecutionDestinationReceiptSchema>
