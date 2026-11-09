import { z } from 'zod'
import { T3ExecutionPendingEffectObservationSchema } from './execution-resource.js'

const id = z.string().min(1).max(256).refine(value => new TextEncoder().encode(value).length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value))
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const edge = { parentCommandId: id, commandId: id, threadId: id }
/** Private protected-original callback metadata. No phase grants SQL/process effects. */
export const T3ExecutionOriginalCommandEdgeSchema = z.discriminatedUnion('phase', [
  z.object({ ...edge, phase: z.literal('initial-created'), messageId: id }).strict(),
  z.object({ ...edge, phase: z.literal('initial-accepted'), messageId: id, runId: id }).strict(),
  z.object({ ...edge, phase: z.literal('release-created'), runId: id }).strict(),
  z.object({ ...edge, phase: z.literal('release-accepted'), runId: id }).strict(),
])
export type T3ExecutionOriginalCommandEdge = z.infer<typeof T3ExecutionOriginalCommandEdgeSchema>

/** Service-observed SQL and protected callback facts only. Not a signed receipt. */
export const T3ExecutionOriginalCommandEvidenceSchema = z.object({
  parentCommandId: id, parentCommandType: z.enum(['thread.create', 'thread.metadata.update']),
  initialCommandId: id, releaseCommandId: id, threadId: id, messageId: id, runId: id,
  providerInstanceId: id, parentReceiptDigest: digest, initialReceiptDigest: digest,
  initialRunEventDigest: digest, releaseReceiptDigest: digest, releaseRunEventDigest: digest,
}).strict()
export const T3ExecutionBoundPendingEffectObservationSchema = z.object({
  observation: T3ExecutionPendingEffectObservationSchema,
  original: T3ExecutionOriginalCommandEvidenceSchema,
}).strict()
export type T3ExecutionBoundPendingEffectObservation = z.infer<typeof T3ExecutionBoundPendingEffectObservationSchema>
