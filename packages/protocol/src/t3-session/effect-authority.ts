import { z } from 'zod'

const reference = z.string().min(1).max(512)
export const T3NativeEffectAssociationSchema = z.object({
  driver: z.enum(['codex', 'claude']), nativeId: reference,
  continuationHomeKey: reference, historyHomeKey: reference,
}).strict()
/** Selection is data until the owning backend consumes its exact original admission. */
export const T3EffectSelectionSchema = z.object({
  kind: z.literal('t3-effect'), version: z.literal(1), purpose: z.literal('execute'),
  executorId: z.string().uuid(), environmentId: reference, threadId: reference, providerSessionId: reference,
  connectionEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/u), runtimeGeneration: reference,
  correlationId: reference, commandId: reference,
  requestDigest: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
  nativeAssociation: T3NativeEffectAssociationSchema,
}).strict()
export type T3EffectSelection = z.infer<typeof T3EffectSelectionSchema>
export const T3EffectGrantReferenceSchema = T3EffectSelectionSchema.extend({
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), requestNonce: z.string().uuid(),
  requestProofDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict().superRefine((grant, context) => {
  const duration = Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)
  if (duration <= 0 || duration > 5_000) context.addIssue({ code: z.ZodIssueCode.custom,
    message: 'T3 effect grants have a finite five-second lifetime.' })
})
export type T3EffectGrantReference = z.infer<typeof T3EffectGrantReferenceSchema>
export const T3EffectAuthorityCheckSchema = z.object({
  executorId: z.string().uuid(), connectionEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  selection: T3EffectSelectionSchema, observedAt: z.string().datetime(), requestNonce: z.string().uuid(),
  signature: z.string().min(32).max(256),
}).strict()
export type T3EffectAuthorityCheck = z.infer<typeof T3EffectAuthorityCheckSchema>
export const T3EffectAuthorityCheckedSchema = z.object({
  grant: T3EffectGrantReferenceSchema, keyId: reference, signature: z.string().min(32).max(4096),
}).strict()
export type T3EffectAuthorityChecked = z.infer<typeof T3EffectAuthorityCheckedSchema>
export const T3_EFFECT_SIGNATURE_DOMAIN = 'nessie.executor.t3.effect-grant.v1'
export const t3EffectSelection = (grant: T3EffectGrantReference): T3EffectSelection => {
  const selection = { ...grant }
  for (const field of ['issuedAt', 'expiresAt', 'requestNonce', 'requestProofDigest']) {
    Reflect.deleteProperty(selection, field)
  }
  return T3EffectSelectionSchema.parse(selection)
}
