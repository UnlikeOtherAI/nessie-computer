import { z } from 'zod'
import { RetainedImportDaemonEnvelopeSchema, RetainedImportSourceSchema } from './retained-import.js'
import { ExecutorSsoVerificationSchema } from './executor.js'

const keyId = z.string().regex(/^[a-f0-9]{64}$/u)
const ms = z.number().int().nonnegative().safe()
export const RetainedIssuerSourceSchema = RetainedImportSourceSchema.omit({ captureGeneration: true })
export const RetainedIssuerOfferSchema = RetainedIssuerSourceSchema.extend({
  publicKey: z.string().min(1).max(512), keyId, expiresAtMs: ms,
}).strict()
export const RetainedIssuerOfferReportSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('issuer.offer'), offer: RetainedIssuerOfferSchema,
}).strict()
export const RetainedIssuerEnrollmentInputSchema = z.object({
  offerId: z.string().uuid(), requestId: z.string().uuid(),
}).strict()
export const RetainedIssuerApproveSchema = z.object({
  keyId, delegation: z.literal('prospective-source-issuer'), ssoVerification: ExecutorSsoVerificationSchema,
}).strict()
export const RetainedIssuerEnrollmentChallengeSchema = RetainedIssuerSourceSchema.extend({
  enrollmentId: z.string().uuid(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), publicKey: z.string(), keyId,
  recipient: z.object({ subject: z.string(), organizationId: z.string(), teamId: z.string() }).strict(),
  expiresAtMs: ms,
}).strict()
export const RetainedIssuerPossessionProofSchema = z.object({
  enrollmentId: z.string().uuid(), keyId, nativeSignature: z.string().min(1).max(256),
}).strict()
export const RetainedIssuerProofReportSchema = RetainedImportDaemonEnvelopeSchema.extend({
  operation: z.literal('issuer.proof'), proof: RetainedIssuerPossessionProofSchema,
}).strict()
export const RetainedIssuerReviewSchema = z.object({
  enrollmentId: z.string().uuid(), status: z.enum(['pending-local', 'pending-human', 'active', 'revoked', 'expired']),
  challenge: RetainedIssuerEnrollmentChallengeSchema,
  delegation: z.literal('prospective-source-issuer'), historicalOwnership: z.literal('unproven'),
}).strict()
export const RetainedIssuerDiscoverySchema = z.object({
  offers: z.array(RetainedIssuerOfferSchema.extend({ offerId: z.string().uuid() })),
  enrollments: z.array(RetainedIssuerReviewSchema),
}).strict()
export type RetainedIssuerEnrollmentChallenge = z.infer<typeof RetainedIssuerEnrollmentChallengeSchema>
export type RetainedIssuerReview = z.infer<typeof RetainedIssuerReviewSchema>
