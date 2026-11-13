import { z } from 'zod'
import { T3ExecutionBindingSchema, T3ExecutionCustodySchema, T3ExecutionGenerationSchema,
  executionReceiptBytes } from './native-execution.js'

export const T3_EXECUTION_SECRET_READ_PREPARATION_DOMAIN = 'nessie.t3.execution.secret-read-preparation.v1' as const
export const T3_EXECUTION_SECRET_READ_DOMAIN = 'nessie.t3.execution.secret-read.v1' as const
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const id = z.string().min(1).max(512)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const name = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`
const reference = z.string().max(1024)
  .regex(new RegExp(String.raw`^op://${name}(?:/${name}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`, 'u'))
export const T3ExecutionSecretReferenceSchema = z.object({
  provider: z.string().max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u), reference,
}).strict()
export const T3ExecutionSecretEnvironmentSlotSchema = z.object({
  index: z.number().int().nonnegative().max(255),
  name: z.string().max(128).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/u),
  reference: T3ExecutionSecretReferenceSchema,
}).strict()
export const T3ExecutionSecretPlanSelectionSchema = z.object({
  environment: z.array(T3ExecutionSecretEnvironmentSlotSchema).max(256),
  // Pinned CodexSettings and ClaudeSettings contain no secret annotations.
  config: z.array(z.never()).length(0),
  references: z.array(T3ExecutionSecretReferenceSchema).max(256),
}).strict().superRefine((value, context) => {
  if (value.environment.length !== value.references.length
    || value.environment.some((slot, index) => (index > 0 && slot.index <= value.environment[index - 1]!.index)
      || slot.reference.provider !== value.references[index]?.provider
      || slot.reference.reference !== value.references[index]?.reference)) {
    context.addIssue({ code: 'custom', message: 'Secret selection must preserve every original environment slot' })
  }
})
export const T3ExecutionSecretPlanEvidenceSchema = z.object({
  resourceId: hex, resourceGeneration: sha, settingsIdentity: id, settingsDigest: hex,
  providerInstanceId: id, providerConfigDigest: sha, secretProvidersDigest: sha,
  credentialHomeReferenceId: hex, custody: T3ExecutionCustodySchema,
}).strict()
/** Candidate metadata only. Native reconstructs it from the held settings FILE. */
export const T3ExecutionSecretPlanCandidateSchema = z.object({
  evidence: T3ExecutionSecretPlanEvidenceSchema, selection: T3ExecutionSecretPlanSelectionSchema,
}).strict()
export type T3ExecutionSecretPlanCandidate = z.infer<typeof T3ExecutionSecretPlanCandidateSchema>
export type T3ExecutionSecretEnvironmentSlot = z.infer<typeof T3ExecutionSecretEnvironmentSlotSchema>
/** Fixed native metadata observation. It grants no secret read or value release. */
export const T3ExecutionSecretObservationInputSchema = z.object({
  binding: T3ExecutionBindingSchema, acceptedGraphNonce: hex,
  candidate: T3ExecutionSecretPlanCandidateSchema,
  environmentIndex: z.number().int().nonnegative().max(255), recipientSlotId: hex,
}).strict()
export type T3ExecutionSecretObservationInput = z.infer<typeof T3ExecutionSecretObservationInputSchema>
export const T3ExecutionSecretObservationUnavailableSchema = z.object({
  status: z.literal('unavailable'), reason: z.literal('T3_SECRET_READ_NONINTERACTIVE_UNQUALIFIED'), attemptId: hex,
}).strict()
export type T3ExecutionSecretObservationUnavailable = z.infer<typeof T3ExecutionSecretObservationUnavailableSchema>
const read = z.object({
  version: z.literal(1), action: z.literal('selected-provider-secret-read'),
  binding: T3ExecutionBindingSchema, acceptedGraphNonce: hex,
  planId: hex, planDigest: sha, readId: hex,
  evidence: T3ExecutionSecretPlanEvidenceSchema,
  slot: T3ExecutionSecretEnvironmentSlotSchema,
  recipient: z.object({ slotId: hex, generation: T3ExecutionGenerationSchema }).strict(),
  tool: z.object({ kind: z.literal('one_password'), installationDigest: sha, imageDigest: sha,
    version: z.string().min(1).max(128), account: z.string().max(253).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    ownerProfileIdentity: id, environmentDigest: sha, processDescriptorDigest: sha,
  }).strict(),
  maxValueBytes: z.literal(65536), nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
const bound = (value: z.infer<typeof read>, context: z.RefinementCtx) => {
  if (value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 5000) {
    context.addIssue({ code: 'custom', message: 'Secret read and delivery share one five-second total deadline' })
  }
  const recipient = value.recipient.generation, runtime = value.evidence.custody.runtime
  if (value.binding.providerInstanceId !== value.evidence.providerInstanceId
    || value.binding.credentialBindingId !== value.evidence.credentialHomeReferenceId
    || recipient.pid !== runtime.pid || recipient.bootId !== runtime.bootId
    || recipient.startedAt !== runtime.startedAt) {
    context.addIssue({ code: 'custom', message: 'Secret recipient must be the selected held graph and instance' })
  }
}
export const T3ExecutionSecretReadPreparationPayloadSchema = read.superRefine((value, context) => {
  bound(value, context)
  if (value.nonce !== value.readId) context.addIssue({ code: 'custom', message: 'Read nonce must name its held read' })
})
export type T3ExecutionSecretReadPreparation = z.infer<typeof T3ExecutionSecretReadPreparationPayloadSchema>
export const T3ExecutionSecretReadAdmissionSchema = read.extend({
  issuerKeyId: hex, preparationReceiptDigest: sha,
}).superRefine(bound)
export type T3ExecutionSecretReadAdmission = z.infer<typeof T3ExecutionSecretReadAdmissionSchema>
export const executionSecretReadAdmissionBytes = (payload: string): Uint8Array =>
  executionReceiptBytes(T3_EXECUTION_SECRET_READ_DOMAIN, payload)

/** Private authenticated graph channel only; never a daemon/backend receipt. */
export const T3_EXECUTION_SECRET_DELIVERY_DOMAIN = 'nessie.t3.execution.secret-delivery.v1' as const
export const T3_EXECUTION_SECRET_INSTALLED_DOMAIN = 'nessie.t3.execution.secret-installed.v1' as const
export const T3ExecutionSecretDeliveryHeaderSchema = z.object({
  version: z.literal(1), type: z.literal('t3.secret.value'), graphId: hex,
  readId: hex, slotId: hex, nonce: hex, admissionDigest: sha, recipient: T3ExecutionGenerationSchema,
  child: T3ExecutionGenerationSchema, expiresAtMs: millis,
  byteLength: z.number().int().nonnegative().max(65536),
  clearance: z.literal('service-observed-job-empty'),
}).strict()
export type T3ExecutionSecretDeliveryHeader = z.infer<typeof T3ExecutionSecretDeliveryHeaderSchema>
