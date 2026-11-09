import { z } from 'zod'
import { T3ExecutionBindingSchema } from './native-execution.js'
import { T3ExecutionDestinationEvidenceSchema } from '../execution-resource.js'
import { T3ExecutionBoundPendingEffectObservationSchema } from '../execution-command-lineage.js'

export const T3_EXECUTION_PRECLAIM_PREPARATION_DOMAIN = 'nessie.t3.execution.sql-preclaim-preparation.v1' as const
export const T3_EXECUTION_PRECLAIM_DOMAIN = 'nessie.t3.execution.sql-preclaim.v1' as const
export const T3_EXECUTION_PRECLAIM_ID_DOMAIN = 'nessie.t3.execution.sql-preclaim.slot.v1' as const
export const executionPreclaimAdmissionBytes = (payload: string): Uint8Array =>
  new TextEncoder().encode(`${T3_EXECUTION_PRECLAIM_DOMAIN}\n${payload}`)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const base = z.object({
  version: z.literal(1), action: z.literal('claim-original-provider-turn-start'), binding: T3ExecutionBindingSchema,
  acceptedGraphNonce: hex, claimId: hex,
  evidence: T3ExecutionDestinationEvidenceSchema,
  bound: T3ExecutionBoundPendingEffectObservationSchema,
  nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
const recognized = (value: z.infer<typeof base>): boolean => {
  const { observation: row, original } = value.bound
  return value.expiresAtMs > value.issuedAtMs && value.issuedAtMs >= row.observedAtMs
    && value.expiresAtMs <= row.observedAtMs + 5000
    && row.effectType === 'provider-turn.start' && row.commandType === 'prepared-run.release'
    && row.commandId === original.releaseCommandId && row.threadId === original.threadId
    && row.receiptDigest === original.releaseReceiptDigest
    && original.parentCommandId === value.binding.commandId && original.threadId === value.binding.threadId
    && original.providerInstanceId === value.binding.providerInstanceId
}
/** Enrolled native observation only. This cannot authorize the SQL transition. */
export const T3ExecutionPreclaimPreparationPayloadSchema = base.refine(value => recognized(value)
  && value.nonce === value.claimId && value.issuedAtMs === value.bound.observation.observedAtMs)
export const T3ExecutionPreclaimAdmissionSchema = base.extend({
  issuerKeyId: hex, preparationReceiptDigest: sha,
}).refine(recognized)
export type T3ExecutionPreclaimPreparation = z.infer<typeof T3ExecutionPreclaimPreparationPayloadSchema>
export type T3ExecutionPreclaimAdmission = z.infer<typeof T3ExecutionPreclaimAdmissionSchema>
