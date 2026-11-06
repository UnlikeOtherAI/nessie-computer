import { z } from 'zod'
import {
  PersonalChatgptProfileStatusSchema, PersonalInferencePrincipalSchema,
  type PersonalChatgptProfileStatus, type ExecutorInferenceSource,
} from '@nessie/executor-protocol'
import { CHATGPT_ISSUER } from './chatgpt-oauth-provider.js'

/** Local OpenAI registration mapping is distinct from UOA human authority. */
export const ChatgptProfileRecordSchema = PersonalChatgptProfileStatusSchema
  .omit({ backgroundConsentRevision: true }).extend({
  format: z.literal(1), revision: z.number().int().nonnegative(),
  accountGeneration: z.number().int().positive(), consentRevision: z.number().int().positive(),
  principal: PersonalInferencePrincipalSchema.nullable(),
  registration: z.object({
    clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u)
      .refine((value) => value !== 'dynamic_agent_client').nullable(),
    extAgentHostId: z.string().uuid(), issuer: z.literal(CHATGPT_ISSUER),
    subject: z.string().min(1).max(512).nullable(),
  }).strict(),
  publicKey: z.string().min(32).max(1024).nullable(),
  credentialProcess: z.object({
    pid: z.number().int().positive(), startedAt: z.string().regex(/^\d+$/u),
    bootId: z.string().uuid(),
  }).strict().nullable(),
  /** An intentional software restart preserves the existing registration and consent. */
  restartAfterUpdate: z.object({ version: z.string().regex(/^\d{1,16}\.\d{1,16}\.\d{1,16}$/u),
    operationId: z.string().uuid() }).strict().optional(),
}).strict()
export type ChatgptProfileRecord = z.infer<typeof ChatgptProfileRecordSchema>

/** Account/disclosure identity is independent of the local background permission. */
export const chatgptProfileSource = (profile: ChatgptProfileRecord):
Extract<ExecutorInferenceSource, { kind: 'chatgpt' }> => ({
  kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan', profileId: profile.profileId,
  accountGeneration: profile.accountGeneration, consentRevision: profile.consentRevision,
})

const Token = z.string().min(1).max(128 * 1024)
export const ChatgptTokenRecordSchema = z.object({
  format: z.literal(1), profileId: z.string().uuid(), accountGeneration: z.number().int().positive(),
  consentRevision: z.number().int().positive(), revision: z.number().int().positive(),
  /** A published spent marker never contains a retryable predecessor token. */
  rotationId: z.string().uuid().nullable(),
  tokens: z.object({
    idToken: Token, accessToken: Token.nullable(), refreshToken: Token.nullable(),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    scopes: z.array(z.string().min(1).max(256)).max(64),
    subject: z.string().min(1).max(512), issuer: z.literal(CHATGPT_ISSUER),
  }).strict().nullable(),
}).strict().superRefine((record, context) => {
  if ((record.rotationId === null) !== (record.tokens !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A spent refresh record contains no credential bytes.' })
  }
})
export type ChatgptTokenRecord = z.infer<typeof ChatgptTokenRecordSchema>

export const ChatgptSigningKeySchema = z.object({
  format: z.literal(1), profileId: z.string().uuid(), publicKey: z.string().min(32).max(1024),
  privateKey: z.string().min(32).max(4096),
}).strict()

/** Deliberate public projection: no OpenAI mapping, key or credential process. */
export const publicChatgptProfileStatus = (record: ChatgptProfileRecord): PersonalChatgptProfileStatus =>
  PersonalChatgptProfileStatusSchema.parse({
    profileId: record.profileId, apiOrigin: record.apiOrigin, executorId: record.executorId,
    organizationId: record.organizationId, teamId: record.teamId, phase: record.phase, reason: record.reason,
    planEnabled: record.planEnabled, hostExecutionRestricted: record.hostExecutionRestricted,
    operationId: record.operationId,
  })
