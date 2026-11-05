import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema } from './schema-primitives.js'

export const VerificationFactorTypeSchema = z.enum([
  'email_otp',
  'email_link',
  'totp',
  'recovery_code',
  'webauthn',
])
export type VerificationFactorType = z.infer<typeof VerificationFactorTypeSchema>

export const AccessActorSchema = z.object({
  actorType: z.enum(['user', 'agent', 'service']),
  actorId: NonEmptyStringSchema,
  roles: z.array(NonEmptyStringSchema).optional(),
})
export type AccessActor = z.infer<typeof AccessActorSchema>

export const TenantContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
})
export type TenantContext = z.infer<typeof TenantContextSchema>

export const UoaSessionIdentitySchema = z.object({
  subject: NonEmptyStringSchema,
  organizationId: NonEmptyStringSchema,
  teamId: NonEmptyStringSchema,
  tokenVersion: z.number().int().nonnegative().nullable(),
  // Opaque local custody reference; confidential UOA proof never enters JWTs or jobs.
  assuranceCredentialId: z.string().uuid().optional(),
})
export type UoaSessionIdentity = z.infer<typeof UoaSessionIdentitySchema>

/** Server-captured paid-work origin. It never lends the payer's tool identity. */
export const RunBillingOriginContextSchema = z.object({
  userId: UserIdSchema,
  uoaIdentity: UoaSessionIdentitySchema.optional(),
})
export type RunBillingOriginContext = z.infer<typeof RunBillingOriginContextSchema>

/** Captured human authorizer for configured machine work; never its effective tool identity. */
export const HumanAuthorizationOriginSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema,
  uoaIdentity: UoaSessionIdentitySchema.optional(),
  userId: UserIdSchema,
})
export type HumanAuthorizationOrigin = z.infer<typeof HumanAuthorizationOriginSchema>

export const ActionContextSchema = z.object({
  authorizerOrigin: HumanAuthorizationOriginSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  effectiveUserId: UserIdSchema.optional(),
  billingOrigin: RunBillingOriginContextSchema.optional(),
  // Authored only by the dedicated one-use product handoff route. Never a human identity.
  siteAgentHost: z.object({ authorizationId: z.string().uuid(), revision: z.number().int().positive(),
    externalSubjectRef: z.string().min(16).max(128) }).strict().optional(),
  toolId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  pushRegistrationVersion: NonEmptyStringSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  purpose: z.string().optional(),
  // Server-authored machine work. Never inferred from an absent human proof.
  machinePurpose: z.enum(['agent.mailbox_delivery', 'agent.reminder']).optional(),
  machineSourceId: z.string().uuid().optional(),
  /// The paired MCP credential this call arrived on.
  ///
  /// The actor is the human who approved the pairing — that is the whole design
  /// — which leaves nothing in the actor to distinguish a task their agent moved
  /// from one they moved themselves. Carrying the credential here means every
  /// audit event gets that fact without each tool having to remember to stamp
  /// it, and it is what `ApprovalRequest.agentAccessCredentialId` is set from.
  agentCredentialId: NonEmptyStringSchema.optional(),
  uoaIdentity: UoaSessionIdentitySchema.optional(),
  // Verified by the live UOA /org/me request at admission; never supplied by a client.
  uoaTeamRoles: z.record(z.string(), z.string()).optional(),
  /// The work record a `ticket.work` run serves (docs/standards/ticket-work.md).
  /// Set only by the platform when it wakes the record, and read by run setup
  /// to admit the ticket tools and by the wake that folds a second event into
  /// a still-pending kickoff for the same record.
  ticketWorkId: z.string().uuid().optional(),
  /// The delivery an internal-event run serves (docs/standards/internal-events.md).
  /// Set only by `fireInternalEvent`; read by run setup for the confinement and
  /// `event_result_submit`, and by the fold that finds a pending kickoff.
  internalEventDeliveryId: z.string().uuid().optional(),
  /// The customer request a `clients.service` run carries out
  /// (docs/standards/clients-services.md). Set only by the service start job;
  /// read by run setup and every tool call for the run's confinement.
  clientsServiceRequestId: z.string().uuid().optional(),
})
export type ActionContext = z.infer<typeof ActionContextSchema>

export const AccessContextSchema = z.object({
  actor: AccessActorSchema,
  tenant: TenantContextSchema,
  actionContext: ActionContextSchema,
})
export type AccessContext = z.infer<typeof AccessContextSchema>

export const AuthorizedActionContextSchema = AccessContextSchema.extend({
  approval: z
    .object({
      approverId: NonEmptyStringSchema.optional(),
      /**
       * The presser's UOA identity, captured at resolve for an action whose
       * continuation must be signed as the person who decided
       * (`deepcrm.tool.continue`). Absent for every other approval.
       */
      approverIdentity: UoaSessionIdentitySchema.optional(),
      approvalId: NonEmptyStringSchema.optional(),
      approvalProof: NonEmptyStringSchema.optional(),
      approvalContext: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  verification: z
    .object({
      challengeId: NonEmptyStringSchema,
      proof: NonEmptyStringSchema,
      factorType: VerificationFactorTypeSchema.optional(),
    })
    .optional(),
})
export type AuthorizedActionContext = z.infer<typeof AuthorizedActionContextSchema>

export const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: { ...actorContext.actionContext, ...fields },
})

/** Server-captured provenance for deferred agent reminders. Null legacy rows authorize nothing. */
export const AgentReminderAuthorizationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), origin: HumanAuthorizationOriginSchema }),
  z.object({ kind: z.literal('machine'), purpose: z.literal('agent.reminder') }),
])
export type AgentReminderAuthorization = z.infer<typeof AgentReminderAuthorizationSchema>
