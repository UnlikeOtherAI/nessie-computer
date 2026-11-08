import { z } from 'zod'

export const T3_EXECUTION_ADMISSION_DOMAIN = 'nessie.t3.execution.admission.v1' as const
export const T3_EXECUTION_INSPECTION_DOMAIN = 'nessie.t3.execution.inspection.v1' as const
export const T3_EXECUTION_ISSUER_DOMAIN = 'nessie.t3.execution.issuer.v1' as const
export const T3_EXECUTION_RESERVATION_DOMAIN = 'nessie.t3.execution.reservation.v1' as const
export const T3_EXECUTION_ASSOCIATION_DOMAIN = 'nessie.t3.execution.association.v1' as const
export const T3_EXECUTION_GRAPH_DOMAIN = 'nessie.t3.execution.graph.v1' as const
export const T3_EXECUTION_PREPARATION_DOMAIN = 'nessie.t3.execution.preparation.v1' as const
export const T3_EXECUTION_HISTORY_RESULT_DOMAIN = 'nessie.t3.execution.history-result.v1' as const
export const T3ExecutionProcessPurposeSchema = z.enum(['provider', 'claude-history-read', 'claude-history-fork'])
export type T3ExecutionProcessPurpose = z.infer<typeof T3ExecutionProcessPurposeSchema>
/** Sign the exact payload bytes. No reserialization, key from receipt, or import-domain reuse. */
export const t3ExecutionSigningBytes = (domain: string, payload: string): string => `${domain}\n${payload}`
export const executionAdmissionBytes = (payload: string): Uint8Array =>
  new TextEncoder().encode(t3ExecutionSigningBytes(T3_EXECUTION_ADMISSION_DOMAIN, payload))
export const executionReceiptBytes = (domain: string, payload: string): Uint8Array =>
  new TextEncoder().encode(t3ExecutionSigningBytes(domain, payload))
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
  admission.extend({ phase: z.literal('launch'), launchDigest: sha, processPurpose: T3ExecutionProcessPurposeSchema }),
  admission.extend({ phase: z.literal('associate'), launchDigest: sha, providerSessionId: id,
    processPurpose: z.literal('provider') }),
]).superRefine((value, context) => {
  if (value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 5000) {
    context.addIssue({ code: 'custom', message: 'Execution admission lifetime must be positive and at most 5000ms' })
  }
})
export const T3ExecutionSignedAdmissionSchema = z.object({ payload: z.string().min(1).max(32768),
  keyId: id, signature: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(2048),
}).strict()
export const T3ExecutionReceiptSchema = z.object({ domain: z.enum([
  T3_EXECUTION_ISSUER_DOMAIN, T3_EXECUTION_RESERVATION_DOMAIN, T3_EXECUTION_ASSOCIATION_DOMAIN,
  T3_EXECUTION_GRAPH_DOMAIN,
  T3_EXECUTION_PREPARATION_DOMAIN,
  T3_EXECUTION_HISTORY_RESULT_DOMAIN,
  'nessie.t3.execution.frame-preparation.v1',
  'nessie.t3.execution.secret-read-preparation.v1',
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
  processPurpose: z.literal('provider'),
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
export type T3ExecutionSignedAdmission = z.infer<typeof T3ExecutionSignedAdmissionSchema>
export type T3ExecutionIssuerProofPayload = z.infer<typeof T3ExecutionIssuerProofPayloadSchema>

/** Original graph owner supplies all resolved request targets; no prelaunch provider identities. */
export const T3ExecutionGraphPayloadSchema = z.object({ version: z.literal(1), nonce: hex,
  binding: T3ExecutionBindingSchema.omit({ sourceEvidenceDigest: true }),
  sourceRevision: z.literal('25bf84ab07f53f141c20239c63e383823a9d5ea0'),
  targets: z.array(z.object({ kind: z.enum(['thread', 'project', 'environment', 'workspace', 'attachment',
    'terminal', 'scheduled-task', 'provider-instance', 'turn-item']), id: z.string().min(1).max(32768),
  scope: z.enum(['existing', 'create', 'resolve']), environmentId: id.optional() }).strict()).max(256),
  custody: T3ExecutionCustodySchema, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
export type T3ExecutionGraph = z.infer<typeof T3ExecutionGraphPayloadSchema>
/** Nonexecuting backend challenge; source/configuration inspection grants no native launch. */
export const T3ExecutionInspectionSchema = z.object({ version: z.literal(1), inspectionId: hex,
  issuerKeyId: hex, nonce: hex, executorId: id, environmentId: id, connectionEpoch: id,
  runtimeGeneration: id, correlationId: id, commandId: id, requestSha256: sha,
  relayHmac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u), actorReference: sha, initiationReference: sha,
  sourceRootKey: id, sourceGeneration: id,
  sourceRevision: T3ExecutionGraphPayloadSchema.shape.sourceRevision,
  targets: T3ExecutionGraphPayloadSchema.shape.targets,
  issuedAtMs: millis, expiresAtMs: millis,
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 5000) {
    context.addIssue({ code: 'custom', message: 'Inspection lifetime must be positive and at most 5000ms' })
  }
})
export type T3ExecutionInspection = z.infer<typeof T3ExecutionInspectionSchema>
export const T3ExecutionPreparationPayloadSchema = T3ExecutionReservationPayloadSchema.extend({
  launchDigest: sha,
  providerSessionId: id,
  processPurpose: T3ExecutionProcessPurposeSchema,
}).strict()
export type T3ExecutionPreparation = z.infer<typeof T3ExecutionPreparationPayloadSchema>
export const T3ExecutionHistoryResultPayloadSchema = T3ExecutionPreparationPayloadSchema.extend({
  processPurpose: z.enum(['claude-history-read', 'claude-history-fork']),
  historyPayloadDigest: sha, resultDigest: sha, resultBytes: z.number().int().nonnegative().max(1_048_576),
  child: T3ExecutionGenerationSchema, exitCode: z.literal(0), clearance: z.literal('service-observed-job-empty'),
}).strict()
export type T3ExecutionHistoryResult = z.infer<typeof T3ExecutionHistoryResultPayloadSchema>
