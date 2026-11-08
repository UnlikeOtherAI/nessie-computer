import { z } from 'zod'

export const T3_EXECUTION_ADMISSION_DOMAIN = 'nessie.t3.execution.admission.v1' as const
export const T3_EXECUTION_ISSUER_DOMAIN = 'nessie.t3.execution.issuer.v1' as const
export const T3_EXECUTION_RESERVATION_DOMAIN = 'nessie.t3.execution.reservation.v1' as const
export const T3_EXECUTION_ASSOCIATION_DOMAIN = 'nessie.t3.execution.association.v1' as const
/** Sign the exact payload bytes. No reserialization, key from receipt, or import-domain reuse. */
export const t3ExecutionSigningBytes = (domain: string, payload: string): string => `${domain}\n${payload}`
const id = z.string().min(1).max(512)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const origin = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && url.origin === value
})
export const T3ExecutionGenerationSchema = z.object({ pid: z.number().int().positive(),
  startedAt: id, bootId: id }).strict()
export const T3ExecutionCustodySchema = z.object({
  service: T3ExecutionGenerationSchema, controller: T3ExecutionGenerationSchema,
  supervisor: T3ExecutionGenerationSchema, runtime: T3ExecutionGenerationSchema,
  jobName: z.string().regex(/^Global\\NessieCustody-[a-f0-9]{64}$/u), releaseDigest: hex, serviceImageDigest: hex,
}).strict()
export const T3ExecutionIssuerDescriptorSchema = z.object({ version: z.literal(1), executorId: id,
  pairedOrigin: origin, keyId: hex, publicKey: z.string().min(1).max(128),
  custody: T3ExecutionCustodySchema,
}).strict()
export const T3ExecutionIssuerChallengeSchema = z.object({ version: z.literal(1),
  enrollmentId: hex, executorId: id, pairedOrigin: origin, descriptorDigest: sha, nonce: hex,
  issuedAtMs: millis, expiresAtMs: millis,
}).strict()
export const T3ExecutionBindingSchema = z.object({
  executorId: id, environmentId: id, threadId: id, providerInstanceId: id,
  connectionEpoch: id, runtimeGeneration: id, correlationId: id, commandId: id,
  requestSha256: sha, relayHmac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
  actorReference: sha, initiationReference: sha, sourceEvidenceDigest: sha,
  sourceRootKey: id, sourceGeneration: id, driver: z.enum(['codex', 'claude']),
  continuationHomeKey: id, historyHomeKey: id, credentialBindingId: id,
}).strict()
const admission = z.object({ version: z.literal(1), binding: T3ExecutionBindingSchema,
  reservationId: hex, issuerKeyId: hex, releaseDigest: hex, nonce: hex,
  issuedAtMs: millis, expiresAtMs: millis,
}).strict()
export const T3ExecutionAdmissionSchema = z.discriminatedUnion('phase', [
  admission.extend({ phase: z.literal('reserve') }),
  admission.extend({ phase: z.literal('launch'), launchDigest: sha }),
  admission.extend({ phase: z.literal('associate'), launchDigest: sha, providerSessionId: id }),
])
export const T3ExecutionSignedAdmissionSchema = z.object({ payload: z.string().min(1).max(32768),
  keyId: id, signature: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(2048),
}).strict()
export const T3ExecutionReceiptSchema = z.object({ domain: z.enum([
  T3_EXECUTION_ISSUER_DOMAIN, T3_EXECUTION_RESERVATION_DOMAIN, T3_EXECUTION_ASSOCIATION_DOMAIN,
]), payload: z.string().min(1).max(32768), keyId: hex,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
}).strict()
export const T3ExecutionIssuerProofPayloadSchema = z.object({ version: z.literal(1),
  challenge: T3ExecutionIssuerChallengeSchema, descriptor: T3ExecutionIssuerDescriptorSchema,
  approvedAtMs: millis, localApproval: z.literal('protected-owner-dialog'),
}).strict()
export const T3ExecutionReservationPayloadSchema = z.object({ version: z.literal(1),
  reservationId: hex, admissionDigest: sha, binding: T3ExecutionBindingSchema,
  custody: T3ExecutionCustodySchema, nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
export const T3ExecutionAssociationPayloadSchema = T3ExecutionReservationPayloadSchema.extend({
  launchDigest: sha, providerSessionId: id, nativeId: id,
  provider: T3ExecutionGenerationSchema, providerImageDigest: hex,
  observation: z.object({ kind: z.literal('service-held-provider-stdout'), frameDigest: sha,
    requestId: id, observedAtMs: millis }).strict(),
}).strict()
export type T3ExecutionBinding = z.infer<typeof T3ExecutionBindingSchema>
export type T3ExecutionAdmission = z.infer<typeof T3ExecutionAdmissionSchema>
export type T3ExecutionReceipt = z.infer<typeof T3ExecutionReceiptSchema>
export type T3ExecutionIssuerDescriptor = z.infer<typeof T3ExecutionIssuerDescriptorSchema>
export type T3ExecutionIssuerChallenge = z.infer<typeof T3ExecutionIssuerChallengeSchema>
export type T3ExecutionReservation = z.infer<typeof T3ExecutionReservationPayloadSchema>
export type T3ExecutionAssociation = z.infer<typeof T3ExecutionAssociationPayloadSchema>
