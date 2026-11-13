import { z } from 'zod'

const ref = z.string().min(1).max(256).refine(id => new TextEncoder().encode(id).length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(id))
const selectedId = ref
export const RetainedImportSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whole_source') }).strict(),
  z.object({ kind: z.literal('threads'), projectIds: z.array(selectedId).max(64)
    .refine(ids => new Set(ids).size === ids.length), threadIds: z.array(selectedId).min(1).max(64)
    .refine(ids => new Set(ids).size === ids.length, 'Thread identities must be unique.') }).strict(),
])
export const RetainedImportSourceSchema = z.object({
  executorId: z.string().uuid(), environmentId: ref, physicalRootKey: ref, admittedRootKey: ref,
  databaseIdentity: ref, environmentIdentity: ref, captureGeneration: ref,
}).strict()
export const RetainedImportChallengeInputSchema = z.object({
  requestId: z.string().uuid(), issuerEnrollmentId: z.string().uuid(), selection: RetainedImportSelectionSchema,
  acceptedBaseline: z.literal('not_attested_by_original_source'),
  grantExpiresAtMs: z.number().int().nonnegative().safe(),
}).strict()
export const RetainedImportChallengeSchema = RetainedImportSourceSchema
  .merge(RetainedImportChallengeInputSchema).extend({
  version: z.literal(1), challengeId: z.string().uuid(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  grantGeneration: z.string().uuid(), organizationId: z.string().uuid(), teamId: z.string().uuid(),
  recipient: z.object({ subject: ref, organizationId: ref, teamId: ref }).strict(),
  purpose: z.literal('retained-import-read-publish'),
  issuedAtMs: z.number().int().nonnegative().safe(), expiresAtMs: z.number().int().nonnegative().safe(),
  issuerKeyId: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

/** Opaque ONLINE receipt, never offline proof or a daemon assertion of consent. */
export const RetainedImportLocalReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal('native-source-owner-consent'),
  challengeId: z.string().uuid(), challengeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  receiptId: z.string().regex(/^[a-f0-9]{64}$/u), issuerInstance: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAtMs: z.number().int().nonnegative().safe(),
  issuerKeyId: z.string().regex(/^[a-f0-9]{64}$/u), nativeSignature: z.string().min(1).max(256),
}).strict()
export const RetainedImportVerificationSchema = z.object({
  verificationId: z.string().uuid(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  issuedAtMs: z.number().int().nonnegative().safe(), expiresAtMs: z.number().int().nonnegative().safe(),
}).strict()
export const RetainedImportLiveProofSchema = z.object({
  version: z.literal(1), operation: z.enum(['consume', 'recheck', 'revoke']),
  verification: RetainedImportVerificationSchema, issuerKeyId: z.string().regex(/^[a-f0-9]{64}$/u),
  issuerInstance: z.string().regex(/^[a-f0-9]{64}$/u), receiptId: z.string().regex(/^[a-f0-9]{64}$/u),
  challengeDigest: z.string().regex(/^[a-f0-9]{64}$/u), consumptionId: z.string().regex(/^[a-f0-9]{64}$/u),
  observedAtMs: z.number().int().nonnegative().safe(), expiresAtMs: z.number().int().nonnegative().safe(),
  nativeSignature: z.string().min(1).max(256),
}).strict()
export const RetainedImportDaemonEnvelopeSchema = z.object({
  executorId: z.string().uuid(), connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  observedAt: z.string().datetime(), signature: z.string().min(1).max(512),
}).strict()
export const RetainedImportCommitSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('consent.commit'), challenge: RetainedImportChallengeSchema, receipt: RetainedImportLocalReceiptSchema,
  liveProof: RetainedImportLiveProofSchema,
}).strict()
/** Both digests are required: the canonical operation and its keyed broker spool. */
export const RetainedImportOperationBindingSchema = z.object({
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  relayRequestDigest: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u), correlationId: ref,
  scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('environment') }).strict(),
    z.object({ kind: z.literal('thread'), threadId: ref }).strict()]),
}).strict()
export const RetainedImportVerificationRequestSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('verification.issue'), grantId: z.string().uuid(),
  purpose: z.enum(['consume', 'recheck', 'revoke']), leaseId: z.string().uuid().optional(),
  operationBinding: RetainedImportOperationBindingSchema.optional(),
}).strict()
export const RetainedImportWithdrawalSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('consent.withdraw'), grantId: z.string().uuid(), liveProof: RetainedImportLiveProofSchema,
}).strict()
export const RetainedImportGrantStatusSchema = z.object({
  grantId: z.string().uuid(), generation: z.string().uuid(),
  status: z.enum(['pending', 'active', 'revoked', 'expired']),
  basis: z.literal('prospective_import'),
  legacyCopyProvenance: z.literal('not_attested_by_original_source'),
}).strict()
export const RetainedImportGrantReviewSchema = RetainedImportGrantStatusSchema.extend({
  challenge: RetainedImportChallengeSchema, selection: RetainedImportSelectionSchema,
  expiresAtMs: z.number().int().nonnegative().safe(),
}).strict()
export const RetainedImportLeaseInputSchema = z.object({
  grantId: z.string().uuid(), purpose: z.enum(['capture', 'read', 'catalog', 'publish']),
  captureGeneration: ref,
  projectIds: z.array(ref).max(5000).refine(ids => new Set(ids).size === ids.length),
  /** Read and publication batches are finite; capture uses the grant's explicit scope. */
  threadIds: z.array(ref).max(5000).refine(ids => new Set(ids).size === ids.length),
}).strict()
export const RetainedImportLeaseSchema = RetainedImportSourceSchema.extend({
  leaseId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), grantId: z.string().uuid(),
  generation: z.string().uuid(), sourceOwnerGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  localApprovalId: z.string().regex(/^[a-f0-9]{64}$/u),
  selection: RetainedImportSelectionSchema, purpose: z.enum(['capture', 'read', 'catalog', 'publish']),
  expiresAt: z.string().datetime(), basis: z.literal('prospective_import'),
  legacyCopyProvenance: z.literal('not_attested_by_original_source'),
  selectionKey: z.string().regex(/^[a-f0-9]{64}$/u),
  operationBinding: RetainedImportOperationBindingSchema.optional(),
}).strict()
export const RetainedImportActivationSchema = RetainedImportGrantStatusSchema.extend({
  bootstrapLeases: z.array(RetainedImportLeaseSchema).max(2),
}).strict()
export const RetainedImportLeaseCheckSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('lease.check'), leaseId: z.string().uuid(), token: z.string().min(1).max(64),
  grantId: z.string().uuid(), generation: z.string().uuid(), sourceOwnerGeneration: z.string().regex(/^[a-f0-9]{64}$/u),
  source: RetainedImportSourceSchema, purpose: z.enum(['capture', 'read', 'catalog', 'publish']),
  selectionKey: z.string().regex(/^[a-f0-9]{64}$/u),
  threadId: ref.optional(),
  operationBinding: RetainedImportOperationBindingSchema.optional(),
  liveProof: RetainedImportLiveProofSchema,
}).strict()
export type RetainedImportChallenge = z.infer<typeof RetainedImportChallengeSchema>
export type RetainedImportChallengeInput = z.infer<typeof RetainedImportChallengeInputSchema>
export type RetainedImportLocalReceipt = z.infer<typeof RetainedImportLocalReceiptSchema>
export type RetainedImportCommit = z.infer<typeof RetainedImportCommitSchema>
export type RetainedImportLease = z.infer<typeof RetainedImportLeaseSchema>
export type RetainedImportLeaseInput = z.infer<typeof RetainedImportLeaseInputSchema>
export type RetainedImportLeaseCheck = z.infer<typeof RetainedImportLeaseCheckSchema>
export type RetainedImportSelection = z.infer<typeof RetainedImportSelectionSchema>
export type RetainedImportLiveProof = z.infer<typeof RetainedImportLiveProofSchema>
export type RetainedImportVerificationRequest = z.infer<typeof RetainedImportVerificationRequestSchema>
export type RetainedImportOperationBinding = z.infer<typeof RetainedImportOperationBindingSchema>

/** Exact native digest preimage. Order is protocol, not a source catalog sort. */
export function retainedImportChallengeDigestInput(c: RetainedImportChallenge): readonly unknown[] {
  return ['nessie-retained-import-challenge-v1', c.version, c.challengeId, c.nonce, c.requestId,
    c.executorId, c.environmentId, c.admittedRootKey, c.physicalRootKey, c.databaseIdentity, c.environmentIdentity,
    c.organizationId, c.teamId, c.recipient.subject, c.recipient.organizationId, c.recipient.teamId,
    c.selection.kind, c.selection.kind === 'threads' ? c.selection.threadIds : [],
    c.selection.kind === 'threads' ? c.selection.projectIds : [], c.purpose, c.grantGeneration,
    c.captureGeneration, c.acceptedBaseline, c.issuedAtMs, c.expiresAtMs, c.grantExpiresAtMs,
    c.issuerEnrollmentId, c.issuerKeyId]
}
