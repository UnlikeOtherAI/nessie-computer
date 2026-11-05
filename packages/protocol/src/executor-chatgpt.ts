import { z } from 'zod'
import { PersonalInferencePrincipalSchema } from './personal-inference-authority.js'

/** Derived by the server from the current signed daemon connection, never supplied by a model/browser. */
export const ExecutorChatgptContextSchema = z.object({
  protocolVersion: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  executorId: z.string().uuid(),
  hostId: z.string().uuid(),
  hostConnectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  delegationId: z.string().uuid(), profileId: z.string().uuid(), role: z.literal('chatgpt'),
  publicKeyFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  principal: PersonalInferencePrincipalSchema,
  /** Hosted activation remains categorically unavailable. */
  deployment: z.enum(['local', 'selfHosted']),
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict()
export type ExecutorChatgptContext = z.infer<typeof ExecutorChatgptContextSchema>

export const ExecutorChatgptContextRequestSchema = z.object({
  executorId: z.string().uuid(), connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  observedAt: z.string().datetime(), nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  signature: z.string().min(1).max(16_384),
}).strict()

export const ExecutorChatgptDelegationChallengeRequestSchema = ExecutorChatgptContextRequestSchema.extend({
  profileId: z.string().uuid(), publicKey: z.string().min(32).max(1_024),
  serverOrigin: z.string().url().max(512),
})
export const ExecutorChatgptDelegationChallengeSchema = z.object({
  challengeId: z.string().uuid(), nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  executorId: z.string().uuid(), profileId: z.string().uuid(), connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  role: z.literal('chatgpt'), publicKeyFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  principal: PersonalInferencePrincipalSchema, deployment: z.enum(['local', 'selfHosted']),
  expiresAt: z.string().datetime(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export type ExecutorChatgptDelegationChallenge = z.infer<typeof ExecutorChatgptDelegationChallengeSchema>
export const ExecutorChatgptDelegationConfirmSchema = ExecutorChatgptContextRequestSchema.extend({
  challengeId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u),
  companionSignature: z.string().min(32).max(1_024),
})
export const ExecutorChatgptDisconnectSchema = ExecutorChatgptContextRequestSchema.extend({
  profileId: z.string().uuid(), serverOrigin: z.string().url().max(512),
  organizationId: z.string().uuid(), teamId: z.string().uuid(),
}).strict()
