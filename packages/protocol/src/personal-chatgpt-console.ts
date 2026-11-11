import { z } from 'zod'

/** The SIWC cookbook's ChatGPT Settings → Usage doorway. No credentials travel in this URL. */
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage'

const ConnectionName = z.string().trim().min(1).max(80)

const ApiOrigin = z.string().url().max(2048).superRefine((value, context) => {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error('Invalid origin')
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use an exact canonical paired API origin.' })
  }
})

/** Public doorway only. The native owner independently reloads all authority. */
export const PersonalChatgptConnectIntentSchema = z.object({
  version: z.literal(1), kind: z.literal('personal-chatgpt-connect'), apiOrigin: ApiOrigin,
  executorId: z.string().uuid(), organizationId: z.string().uuid(), teamId: z.string().uuid(),
  profileId: z.string().uuid().optional(),
}).strict()
export type PersonalChatgptConnectIntent = z.infer<typeof PersonalChatgptConnectIntentSchema>

export const PersonalChatgptUnavailableReasonSchema = z.enum([
  'runtime_update_required', 'runtime_untracked', 'runtime_inventory_unknown', 'host_sessions_active',
  'elevated_runtime_active', 'native_context_unsupported', 'interactive_user_required', 'service_barrier_unavailable',
  'connection_unavailable', 'owner_authority_unavailable', 'deployment_ineligible', 'plan_permission_missing',
  'registration_unavailable', 'account_replacement_requires_consent', 'refresh_uncertain', 'credential_process_unknown',
  'host_restriction_acknowledgement_required',
])

/** No authorization URL/state/code, credential, identity profile or quota estimate. */
export const PersonalChatgptProfileStatusSchema = z.object({
  profileId: z.string().uuid(), apiOrigin: ApiOrigin, executorId: z.string().uuid(),
  organizationId: z.string().uuid(), teamId: z.string().uuid(),
  phase: z.enum(['unavailable', 'disconnected', 'signing_in',
    'identity_only', 'ready', 'reconnecting', 'disconnecting']),
  reason: PersonalChatgptUnavailableReasonSchema.nullable(), planEnabled: z.boolean(),
  hostExecutionRestricted: z.boolean(), operationId: z.string().uuid().nullable(),
  backgroundConsentRevision: z.number().int().positive().nullable().default(null),
  label: ConnectionName.optional(),
}).strict()
export type PersonalChatgptProfileStatus = z.infer<typeof PersonalChatgptProfileStatusSchema>

export const PersonalChatgptConsoleStatusSchema = z.object({ version: z.literal(1),
  profiles: z.array(PersonalChatgptProfileStatusSchema).max(256),
  reason: PersonalChatgptUnavailableReasonSchema.nullable(),
  restriction: z.literal('unisolated_terminal_coding_and_custom_stdio_blocked'),
}).strict()

/** These operations run on the owning computer; web/service transports carry public intent only. */
export const PersonalChatgptConsoleOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), intent: PersonalChatgptConnectIntentSchema }).strict(),
  z.object({ operation: z.literal('start'), intent: PersonalChatgptConnectIntentSchema,
    acknowledgeHostRestriction: z.boolean().optional(), newProfileId: z.string().uuid().optional(),
    label: ConnectionName.optional() }).strict(),
  z.object({ operation: z.literal('rename'), intent: PersonalChatgptConnectIntentSchema.extend({
    profileId: z.string().uuid(),
  }), label: ConnectionName }).strict(),
  z.object({ operation: z.literal('cancel'), operationId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('disconnect'), intent: PersonalChatgptConnectIntentSchema.extend({
    profileId: z.string().uuid(),
  }) }).strict(),
  z.object({ operation: z.literal('background-consent'), intent: PersonalChatgptConnectIntentSchema.extend({
    profileId: z.string().uuid(),
  }), enabled: z.boolean(), expectedRevision: z.number().int().positive().nullable() }).strict(),
])

/** Bundled console names only its selected connection; the CLI resolves scope locally. */
export const PersonalChatgptLocalOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), profileId: z.string().uuid().optional() }).strict(),
  // `acknowledgeHostRestriction` is what apps through 1.0.40 send; it is read and means nothing.
  z.object({ operation: z.literal('start'), profileId: z.string().uuid().optional(),
    acknowledgeHostRestriction: z.boolean().optional(), newProfileId: z.string().uuid().optional(),
    label: ConnectionName.optional() }).strict(),
  z.object({ operation: z.literal('rename'), profileId: z.string().uuid(), label: ConnectionName }).strict(),
  z.object({ operation: z.literal('cancel'), operationId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('disconnect'), profileId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('background-consent'), profileId: z.string().uuid(),
    enabled: z.boolean(), expectedRevision: z.number().int().positive().nullable() }).strict(),
])
