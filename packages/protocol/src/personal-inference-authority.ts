import { z } from 'zod'

/** Processing location is independent of the authenticated executor transport. */
export const ExecutorInferenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_weights') }).strict(),
  z.object({
    kind: z.literal('chatgpt'),
    processing: z.literal('openai_cloud'),
    billingSource: z.literal('personal_plan'),
    profileId: z.string().uuid(),
    /** Account replacement/reconnection, never ordinary access-token rotation. */
    accountGeneration: z.number().int().positive(),
    consentRevision: z.number().int().positive(),
  }).strict(),
])
export type ExecutorInferenceSource = z.infer<typeof ExecutorInferenceSourceSchema>

/** Legacy source absence can only identify the existing local-weights contract. */
export const isExecutorLocalWeightsSource = (value: { inferenceSource?: ExecutorInferenceSource }): boolean =>
  value.inferenceSource === undefined || value.inferenceSource.kind === 'local_weights'

/** Source equality never conflates cloud generations or depends on object order. */
export const sameExecutorInferenceSource = (
  left: ExecutorInferenceSource | undefined, right: ExecutorInferenceSource | undefined,
): boolean => {
  if (isExecutorLocalWeightsSource({ inferenceSource: left })) {
    return isExecutorLocalWeightsSource({ inferenceSource: right })
  }
  return left?.kind === 'chatgpt' && right?.kind === 'chatgpt'
    && left.profileId === right.profileId && left.accountGeneration === right.accountGeneration
    && left.consentRevision === right.consentRevision
}

export const EXECUTOR_CHATGPT_PROVIDER = 'executor/chatgpt'
export const PERSONAL_INFERENCE_GUARD_VERSION = 2

const identifier = z.string().min(1).max(200)

/** A trusted admission projection, not a model-authored claim or a UOA profile. */
export const PersonalInferencePrincipalSchema = z.object({
  serverOrigin: z.string().url().max(512),
  identityIssuer: z.string().url().max(512),
  organizationId: identifier,
  teamId: identifier,
  ownerUserId: identifier,
  ownerSubject: identifier,
}).strict()
export type PersonalInferencePrincipal = z.infer<typeof PersonalInferencePrincipalSchema>

/** OS credential custody is a person/server boundary; profile entitlement stays team-scoped. */
export const samePersonalInferenceCustodian = (
  left: PersonalInferencePrincipal, right: PersonalInferencePrincipal,
): boolean => left.serverOrigin === right.serverOrigin && left.identityIssuer === right.identityIssuer
  && left.ownerSubject === right.ownerSubject && left.ownerUserId === right.ownerUserId

const AgentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('private'), id: identifier, ownerUserId: identifier, teamId: identifier }).strict(),
  z.object({
    kind: z.literal('builtin_private_overlay'), id: identifier,
    scopeUserId: identifier, soleReaderUserId: identifier, teamId: identifier,
  }).strict(),
])

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interactive'), requestingUserId: identifier, rootRunId: identifier }).strict(),
  z.object({
    kind: z.literal('background'), authorizingUserId: identifier,
    automationId: identifier, authorizationRevision: z.number().int().positive(),
    rootRunId: identifier, backgroundConsentRevision: z.number().int().positive(),
  }).strict(),
])

export const PersonalInferenceAuthoritySchema = z.object({
  principal: PersonalInferencePrincipalSchema,
  agent: AgentSchema,
  origin: OriginSchema,
  runId: identifier,
  /** The admission follows this root through delegation, restart and continuation. */
  rootRunId: identifier,
  /** All recipients of the requesting conversation are this owner. */
  soleReaderUserId: identifier,
}).strict()
export type PersonalInferenceAuthority = z.infer<typeof PersonalInferenceAuthoritySchema>

export type PersonalInferenceAuthorityDecision =
  | { allowed: true; authority: PersonalInferenceAuthority }
  | { allowed: false; reason: 'unknown_authority' | 'owner_mismatch' | 'team_mismatch' | 'origin_mismatch'
    | 'background_not_authorized' }

/** Pure shared policy. Callers obtain its inputs from live, authenticated records. */
export const personalInferenceAuthorityDecision = (
  value: unknown,
  expected: PersonalInferencePrincipal,
  backgroundConsentRevision: number | null = null,
): PersonalInferenceAuthorityDecision => {
  const parsed = PersonalInferenceAuthoritySchema.safeParse(value)
  if (!parsed.success) return { allowed: false, reason: 'unknown_authority' }
  const authority = parsed.data
  const { principal, agent, origin } = authority
  if (principal.serverOrigin !== expected.serverOrigin || principal.identityIssuer !== expected.identityIssuer
    || principal.ownerUserId !== expected.ownerUserId || principal.ownerSubject !== expected.ownerSubject
    || authority.soleReaderUserId !== expected.ownerUserId
    || (agent.kind === 'private' ? agent.ownerUserId !== expected.ownerUserId
      : agent.scopeUserId !== expected.ownerUserId || agent.soleReaderUserId !== expected.ownerUserId)) {
    return { allowed: false, reason: 'owner_mismatch' }
  }
  if (principal.organizationId !== expected.organizationId || principal.teamId !== expected.teamId
    || agent.teamId !== expected.teamId) return { allowed: false, reason: 'team_mismatch' }
  if (origin.rootRunId !== authority.rootRunId
    || (origin.kind === 'interactive' ? origin.requestingUserId : origin.authorizingUserId) !== expected.ownerUserId) {
    return { allowed: false, reason: 'origin_mismatch' }
  }
  if (origin.kind === 'background' && (backgroundConsentRevision === null
    || origin.backgroundConsentRevision !== backgroundConsentRevision)) {
    return { allowed: false, reason: 'background_not_authorized' }
  }
  return { allowed: true, authority }
}


/** Only these established builtin private overlays may spend a personal ChatGPT plan. */
export const isPersonalInferenceBuiltin = (agent: {
  systemManaged?: boolean; agentKind?: string; systemSlug?: string | null;
}): boolean => agent.systemManaged === true && (agent.agentKind === 'personal_assistant'
  || agent.agentKind === 'shared' && agent.systemSlug === 'agent-designer')
