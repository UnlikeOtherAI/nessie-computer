import { z } from 'zod'

import { ExecutorScopeKindSchema, ExecutorScopeSchema, ExecutorSignedDescriptorSchema } from './executor.js'
import { ExecutorPlatformFactsSchema } from './executor-platform.js'

const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const NamedReference = z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()
export const ExecutorPairingCodeSchema = z.string().regex(/^[0-9]{8}$/)
export const ExecutorPairingStartPayloadSchema = z.object({
  requestId: z.string().uuid(),
  timestamp: z.string().datetime(),
  machineName: z.string().trim().min(1).max(120),
  machinePublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  descriptor: ExecutorSignedDescriptorSchema,
  replacesExecutorId: z.string().uuid().optional(),
}).strict()
export const ExecutorPairingStartRequestSchema = ExecutorPairingStartPayloadSchema.extend({
  signature: Signature,
  replacementSignature: Signature.optional(),
}).strict()
export const ExecutorPairingStartResponseSchema = z.object({
  pairingId: z.string().uuid(), code: ExecutorPairingCodeSchema, fingerprint: Digest,
  expiresAt: z.string().datetime(), pollIntervalSeconds: z.literal(3),
}).strict()
export const ExecutorPairingPollRequestSchema = z.object({
  pairingId: z.string().uuid(), timestamp: z.string().datetime(), signature: Signature,
  // The original attempt key lets a current client recover after bounded code retention.
  machinePublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict()
export const ExecutorPairingDecisionRequestSchema = ExecutorPairingPollRequestSchema.extend({
  executorId: z.string().uuid(), claimDigest: Digest,
}).strict()
export const ExecutorPairingConnectionRequestSchema = z.object({
  executorId: z.string().uuid(), timestamp: z.string().datetime(), signature: Signature,
}).strict()
/** The same signed identity proof as a connection read, under its own domain. */
export const ExecutorPairingSignOffRequestSchema = ExecutorPairingConnectionRequestSchema
export const ExecutorPairingSignOffResponseSchema = z.object({ signedOff: z.literal(true) }).strict()
export const ExecutorPairingClaimSchema = z.object({
  executorId: z.string().uuid(), machineName: z.string(), organization: NamedReference,
  team: NamedReference.nullable(), scope: ExecutorScopeSchema, claimDigest: Digest,
}).strict()
export const ExecutorPairingPollResponseSchema = z.object({
  status: z.enum(['waiting', 'confirmed', 'rejected', 'expired']),
  pairingId: z.string().uuid(), fingerprint: Digest, expiresAt: z.string().datetime(),
  claim: ExecutorPairingClaimSchema.optional(),
}).strict()
export const ExecutorPairingPreviewRequestSchema = z.object({ code: ExecutorPairingCodeSchema }).strict()
export const ExecutorPairingPreviewSchema = z.object({
  pairingId: z.string().uuid(), machineName: z.string(), fingerprint: Digest,
  platformFacts: ExecutorPlatformFactsSchema, expiresAt: z.string().datetime(),
}).strict()
export const ExecutorPairingClaimRequestSchema = z.object({
  code: ExecutorPairingCodeSchema, fingerprint: Digest, label: z.string().trim().min(1).max(120),
  scope: ExecutorScopeSchema, teamId: z.string().min(1).max(200).nullable(),
}).strict()
export const ExecutorPairingClaimResponseSchema = z.object({
  executorId: z.string().uuid(), pairingId: z.string().uuid(), status: z.literal('confirmed'),
}).strict()
export const ExecutorPairingOptionsSchema = z.object({
  organization: NamedReference,
  teams: z.array(NamedReference.extend({ projectIds: z.array(z.string().uuid()) }).strict()),
  scopes: z.array(ExecutorScopeKindSchema),
}).strict()
export type ExecutorPairingStartRequest = z.infer<typeof ExecutorPairingStartRequestSchema>
export type ExecutorPairingStartResponse = z.infer<typeof ExecutorPairingStartResponseSchema>
export type ExecutorPairingPollRequest = z.infer<typeof ExecutorPairingPollRequestSchema>
export type ExecutorPairingDecisionRequest = z.infer<typeof ExecutorPairingDecisionRequestSchema>
export type ExecutorPairingConnectionRequest = z.infer<typeof ExecutorPairingConnectionRequestSchema>
export type ExecutorPairingSignOffResponse = z.infer<typeof ExecutorPairingSignOffResponseSchema>
export type ExecutorPairingPollResponse = z.infer<typeof ExecutorPairingPollResponseSchema>
export type ExecutorPairingClaim = z.infer<typeof ExecutorPairingClaimSchema>
export type ExecutorPairingPreview = z.infer<typeof ExecutorPairingPreviewSchema>
export type ExecutorPairingClaimRequest = z.infer<typeof ExecutorPairingClaimRequestSchema>
export type ExecutorPairingClaimResponse = z.infer<typeof ExecutorPairingClaimResponseSchema>
export type ExecutorPairingOptions = z.infer<typeof ExecutorPairingOptionsSchema>
