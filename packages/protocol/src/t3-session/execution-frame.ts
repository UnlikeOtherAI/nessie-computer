import { z } from 'zod'
import { T3ExecutionBindingSchema, T3ExecutionCustodySchema, T3ExecutionGenerationSchema } from './native-execution.js'

export const T3_EXECUTION_FRAME_DOMAIN = 'nessie.t3.execution.frame.v1' as const
export const T3_EXECUTION_FRAME_PREPARATION_DOMAIN = 'nessie.t3.execution.frame-preparation.v1' as const
const id = z.string().min(1).max(512)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const T3ExecutionSerializedFrameSchema = z.object({
  driver: z.enum(['codex', 'claude']),
  kind: z.enum(['request', 'notification', 'response', 'cancel', 'message']),
  protocolId: z.union([id, z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)]).optional(),
  messageId: id.optional(), method: id.optional(), frameSha256: sha,
}).strict()
export type T3ExecutionSerializedFrame = z.infer<typeof T3ExecutionSerializedFrameSchema>
const boundFrame = z.object({ version: z.literal(1), reservationId: hex, frameId: hex,
  binding: T3ExecutionBindingSchema, providerSessionId: id, launchDigest: sha,
  processPurpose: z.literal('provider'), child: T3ExecutionGenerationSchema,
  frame: T3ExecutionSerializedFrameSchema, nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
const finite = (value: { issuedAtMs: number; expiresAtMs: number }, context: z.RefinementCtx) => {
  if (value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 5000) {
    context.addIssue({ code: 'custom', message: 'Frame evidence and admission have a finite five-second lifetime' })
  }
}
export const T3ExecutionFramePreparationPayloadSchema = boundFrame.extend({
  admissionDigest: sha, custody: T3ExecutionCustodySchema,
}).superRefine((value, context) => {
  finite(value, context)
  if (value.nonce !== value.frameId || value.frame.driver !== value.binding.driver) {
    context.addIssue({ code: 'custom', message: 'Frame preparation must match its held identity' })
  }
})
export type T3ExecutionFramePreparation = z.infer<typeof T3ExecutionFramePreparationPayloadSchema>
export const T3ExecutionFrameAdmissionSchema = boundFrame.extend({
  issuerKeyId: hex, releaseDigest: hex, frameReceiptDigest: sha,
}).superRefine(finite)
export type T3ExecutionFrameAdmission = z.infer<typeof T3ExecutionFrameAdmissionSchema>
