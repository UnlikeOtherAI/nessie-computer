import { z } from 'zod'
import { T3ExecutionBindingSchema } from './native-execution.js'
import { T3ExecutionDestinationEvidenceSchema, T3ExecutionLegacyShellObservationSchema } from '../execution-resource.js'

export const T3_EXECUTION_LEGACY_SHELL_PREPARATION_DOMAIN = 'nessie.t3.execution.legacy-shell-preparation.v1' as const
export const T3_EXECUTION_LEGACY_SHELL_DOMAIN = 'nessie.t3.execution.legacy-shell.v1' as const
export const T3_EXECUTION_LEGACY_SHELL_SLOT_DOMAIN = 'nessie.t3.execution.legacy-shell-slot.v1' as const
export const executionLegacyShellAdmissionBytes = (payload: string): Uint8Array =>
  new TextEncoder().encode(`${T3_EXECUTION_LEGACY_SHELL_DOMAIN}\n${payload}`)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const base = z.object({
  version: z.literal(1), action: z.literal('legacy-shell-reconcile'), binding: T3ExecutionBindingSchema,
  acceptedGraphNonce: hex, slotId: hex, evidence: T3ExecutionDestinationEvidenceSchema,
  observation: T3ExecutionLegacyShellObservationSchema, nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
const recognized = (value: z.infer<typeof base>) => value.expiresAtMs > value.issuedAtMs
  && value.issuedAtMs >= value.observation.observedAtMs && value.expiresAtMs <= value.observation.observedAtMs + 5000
/** Enrolled independent evidence. Parsing it supplies no mutation authority. */
export const T3ExecutionLegacyShellPreparationPayloadSchema = base.refine(value => recognized(value)
  && value.nonce === value.slotId && value.issuedAtMs === value.observation.observedAtMs)
export const T3ExecutionLegacyShellAdmissionSchema = base.extend({ issuerKeyId: hex,
  preparationReceiptDigest: sha }).refine(recognized)
export type T3ExecutionLegacyShellPreparation = z.infer<typeof T3ExecutionLegacyShellPreparationPayloadSchema>
export type T3ExecutionLegacyShellAdmission = z.infer<typeof T3ExecutionLegacyShellAdmissionSchema>
