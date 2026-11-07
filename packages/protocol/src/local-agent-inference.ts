import { z } from 'zod'
import { ExecutorInferenceSourceSchema, PersonalInferenceAuthoritySchema } from './personal-inference-authority.js'
import { ResponsesContinuationSchema } from './responses-continuation.js'

import { PaginationMetaSchema } from './api.js'
import { LocalInferenceResourceAttachmentSchema, LocalInferenceResourceControlSchema } from './local-inference-resource.js'
import {
  ModelCapabilitySnapshotSchema,
  ProviderMessageSchema,
  ProviderToolCallSchema,
  ToolSchemaDescriptorSchema,
} from './inference-core.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Contracts for the owner-host-only local Ollama lane.  This is deliberately
 * separate from `local-inference.ts`: that module is a curated download
 * catalogue, whereas these values are observations made by a person's host.
 */
export const LocalInferenceTransportSchema = z.enum(['executor', 'desktop'])
export type LocalInferenceTransport = z.infer<typeof LocalInferenceTransportSchema>

/** The single version both the executor and Desktop-host bridge speak. */
export const LOCAL_INFERENCE_PROTOCOL_VERSION = 1

const LocalInferenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const LocalInferenceMachineSignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(64)
  .max(128)

/**
 * Each host message has an independent sequence lane, so one kind of message
 * can never be replayed as another. `claim` names the signed connection
 * handshake and `poll` the request for an attempt (sent as `claim` on the
 * host socket); `control` is the host's one acceptance of an attempt.
 */
export const LocalInferenceEnvelopePurposeSchema = z.enum([
  'resource',
  'termination',
  'claim',
  'heartbeat',
  'poll',
  'control',
  'frames',
  'result',
  'goodbye',
])
export type LocalInferenceEnvelopePurpose = z.infer<typeof LocalInferenceEnvelopePurposeSchema>

/**
 * The body travels beside this header, but only its canonical digest is signed.
 * Routes still parse their own purpose-specific bounded body before acting.
 */
export const LocalInferenceEnvelopeCoreSchema = z.object({
  bodyDigest: LocalInferenceDigestSchema,
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  /**
   * Present only for executor hosts. It pins the local-host request to the
   * current executor daemon claim, so an older process with the same machine
   * key is fenced immediately when the executor reconnects elsewhere.
   */
  executorConnectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
  hostId: z.string().uuid(),
  organizationId: z.string().uuid(),
  protocolVersion: z.literal(LOCAL_INFERENCE_PROTOCOL_VERSION),
  purpose: LocalInferenceEnvelopePurposeSchema,
  sentAt: z.string().datetime({ offset: true }).max(40),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type LocalInferenceEnvelopeCore = z.infer<typeof LocalInferenceEnvelopeCoreSchema>
export type LocalInferenceEnvelopeCoreInput = z.input<typeof LocalInferenceEnvelopeCoreSchema>

export const LocalInferenceSignedEnvelopeSchema = LocalInferenceEnvelopeCoreSchema.extend({
  signature: LocalInferenceMachineSignatureSchema,
}).strict()
export type LocalInferenceSignedEnvelope = z.infer<typeof LocalInferenceSignedEnvelopeSchema>

/** `pending` is prepared by the host's custodian and waits for their Save. */
export const LocalInferenceBindingStatusSchema = z.enum([
  'pending',
  'active',
  'needs_rebinding',
  'revoked',
])
export type LocalInferenceBindingStatus = z.infer<typeof LocalInferenceBindingStatusSchema>

export const AgentAvailabilitySchema = z.enum(['online', 'offline', 'unknown'])
export type AgentAvailability = z.infer<typeof AgentAvailabilitySchema>

export const LocalInferenceAvailabilityReasonSchema = z.enum([
  'unconfigured',
  'connecting',
  'offline',
  'paused',
  'model_missing',
  'model_changed',
  'incompatible',
  'policy_denied',
  'needs_reauthorization',
  'entitlement_unavailable',
  'revoked',
  'ready',
  'busy',
  /** A teammate's view of a team agent whose computer is not shared with their team. */
  'not_shared',
])
export type LocalInferenceAvailabilityReason = z.infer<
  typeof LocalInferenceAvailabilityReasonSchema
>

const LocalSocketSchema = z.union([
  z.literal('http://127.0.0.1:11434'),
  z.literal('http://[::1]:11434'),
  z.string().regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/),
])

export const ObservedLocalModelSchema = z.object({
  /** Absent belongs to an older local-weights host, never a ChatGPT source. */
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  personalBackgroundConsentRevision: z.number().int().positive().nullable().optional(),
  displayName: NonEmptyStringSchema.max(200).optional(),
  /** Exact provider slug, separate from the collision-free executor model id. */
  providerModelId: NonEmptyStringSchema.max(200).optional(),
  // `thinking` is Ollama's own advertised capability, read from `/api/show`;
  // it is the only per-model reasoning discovery any provider offers.
  capabilities: z.array(z.enum(['text', 'tools', 'json_schema', 'thinking', 'vision'])).max(16),
  /**
   * A model an OpenAI-compatible server at the owner's address describes, identified by that
   * report rather than a weights manifest; absent identifies an observed Ollama weights manifest.
   */
  identitySource: z.literal('owner_configuration').optional(),
  modelRevision: NonEmptyStringSchema.max(256).optional(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  name: NonEmptyStringSchema.max(200),
  numCtxCap: z.number().int().positive().max(2_000_000).nullable(),
  maxOutputTokens: z.number().int().positive().max(200_000).optional(),
  remoteHost: z.string().max(512).nullable(),
  remoteModel: z.string().max(512).nullable(),
  reportedAt: TimestampSchema,
  sizeBytes: z.number().int().nonnegative().nullable(),
}).superRefine((model, ctx) => {
  if (model.personalBackgroundConsentRevision != null
    && model.inferenceSource?.kind !== 'chatgpt') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Background consent belongs to a personal ChatGPT source' })
  }
  if (model.inferenceSource?.kind !== 'chatgpt'
    && ((model.numCtxCap ?? 0) > 1_000_000 || (model.maxOutputTokens ?? 0) > 100_000)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Local model exceeds local capacity bounds' })
  }
  if (model.inferenceSource?.kind === 'chatgpt'
    && (model.numCtxCap === null || model.maxOutputTokens === undefined
      || model.providerModelId === undefined || model.remoteHost !== null || model.remoteModel !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ChatGPT needs verified capacities and an explicit cloud source' })
  }
  // A server that does not report a limit leaves it unknown; Nessie asks the owner for a missing context.
  if (model.identitySource === 'owner_configuration' && model.numCtxCap !== null
    && model.maxOutputTokens !== undefined && model.maxOutputTokens >= model.numCtxCap) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A model cannot produce more than its context holds' })
  }
})
export type ObservedLocalModel = z.infer<typeof ObservedLocalModelSchema>

export const LocalInferenceHostRoleSchema = z.enum(['local_weights', 'chatgpt'])
export const LocalInferenceHostSchema = z.object({
  role: LocalInferenceHostRoleSchema,
  displayLabel: NonEmptyStringSchema,
  personalProfileId: z.string().uuid().nullable(),
  personalTeamId: NonEmptyStringSchema.nullable(),
  availability: AgentAvailabilitySchema,
  canonicalSocket: LocalSocketSchema.nullable(),
  /** The owned executor detail doorway, present only for executor transport. */
  executorId: z.string().uuid().nullable(),
  id: z.string().uuid(),
  lastSeenAt: TimestampSchema.nullable(),
  models: z.array(ObservedLocalModelSchema).max(100),
  paused: z.boolean(),
  /** A local-weights computer shared for use with everyone in the selected team. */
  sharedWithTeam: z.boolean().optional(),
  resource: LocalInferenceResourceControlSchema.optional(),
  status: LocalInferenceBindingStatusSchema.or(z.literal('unconfigured')),
  transport: LocalInferenceTransportSchema,
}).superRefine((host, context) => {
  if (host.role === 'chatgpt' ? host.transport !== 'executor' || !host.personalProfileId || !host.personalTeamId
    : host.personalProfileId !== null || host.personalTeamId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Host source role and scoped profile must agree' })
  }
})
export type LocalInferenceHost = z.infer<typeof LocalInferenceHostSchema>

export const LocalInferenceHostListSchema = z.object({
  /** Whether this deployment can connect personal ChatGPT plans at all (never on hosted Nessie). */
  chatgptAvailable: z.boolean(),
  hosts: z.array(LocalInferenceHostSchema),
  meta: PaginationMetaSchema,
})

export const LocalInferenceMessageSchema = ProviderMessageSchema

/** The effort vocabulary OpenAI-compatible servers accept for `reasoning_effort`. */
export const LocalInferenceReasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
export type LocalInferenceReasoningEffort = z.infer<typeof LocalInferenceReasoningEffortSchema>

export const LocalInferenceAttemptRequestSchema = z.object({
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  personalAuthority: PersonalInferenceAuthoritySchema.optional(),
  attemptId: z.string().uuid(),
  bindingId: z.string().uuid(),
  bindingRevision: z.number().int().positive(),
  deadlineAt: TimestampSchema,
  hostEpoch: z.number().int().positive(),
  hostId: z.string().uuid(),
  invocationId: NonEmptyStringSchema.max(160),
  // Main conversational inference omits an application output ceiling. A
  // bounded operational caller may still supply one explicitly.
  maxOutputTokens: z.number().int().positive().max(200_000).optional(),
  messages: z.array(LocalInferenceMessageSchema).max(1_000),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelName: NonEmptyStringSchema.max(200),
  numCtx: z.number().int().positive().max(2_000_000),
  protocolVersion: z.literal(1),
  runId: z.string().uuid(),
  runFence: NonEmptyStringSchema.max(160),
  // Whether the worker wants the model's separate thinking: true for a live
  // turn whose thought log can show it, absent/false for silent utility calls
  // and for an agent whose effort is `none`. A host only honours it for a
  // model that advertises the `thinking` capability. Optional so an older
  // host reads the request unchanged.
  thinking: z.boolean().optional(),
  // How hard the model should think on a turn that asked for thinking: the
  // agent's effort as a connector receives it. An owner-configured OpenAI
  // endpoint passes it on as `reasoning_effort`; Ollama has no per-model
  // levels and ignores it. Optional so an older worker's request still parses.
  reasoningEffort: LocalInferenceReasoningEffortSchema.optional(),
  tools: z.array(ToolSchemaDescriptorSchema).max(128),
}).superRefine((attempt, context) => {
  if (attempt.inferenceSource?.kind === 'chatgpt') {
    if (!attempt.personalAuthority || attempt.personalAuthority.runId !== attempt.runId) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: 'ChatGPT inference requires its signed private run authority.' })
    }
  } else if (attempt.numCtx > 1_000_000 || (attempt.maxOutputTokens ?? 0) > 100_000
    || attempt.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(attempt.reasoningEffort)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'The existing local-weight attempt capacity is unchanged.' })
  }
})
export type LocalInferenceAttemptRequest = z.infer<typeof LocalInferenceAttemptRequestSchema>

/**
 * A model's tool-call arguments that were not a JSON object arrive under this
 * one key, so the worker's tool gate answers the slip with a correctable tool
 * result the model can read, instead of the host failing the whole attempt.
 */
export { LOCAL_INFERENCE_MALFORMED_ARGUMENTS_KEY } from './provider-tool-arguments.js'

export const PersonalInferenceNonacceptanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_sent') }).strict(),
  z.object({ kind: z.literal('rejected'), httpStatus: z.union([
    z.literal(400), z.literal(401), z.literal(403), z.literal(429),
  ]), structuredError: z.literal(true) }).strict(),
])

export const LocalInferenceResultSchema = z.object({
  personalNonacceptance: PersonalInferenceNonacceptanceSchema.optional(),
  responsesContinuation: ResponsesContinuationSchema.optional(),
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  capability: ModelCapabilitySnapshotSchema,
  content: z.string().max(512 * 1024).nullable(),
  finishReason: z.enum(['stop', 'length', 'tool-call', 'error', 'other']),
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/),
  // The model's separate thinking, joined. Optional so a receipt from an
  // older host still parses; absent when the attempt did not ask for it.
  reasoning: z.string().max(512 * 1024).nullable().optional(),
  remoteHost: z.string().max(512).nullable(),
  remoteModel: z.string().max(512).nullable(),
  toolCalls: z.array(ProviderToolCallSchema).max(128),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  }),
  // The host's own measure from sending the model request to the end of its
  // stream, so transport time and model time are told apart. Optional so an
  // older host's receipt still parses.
  generationMs: z.number().int().nonnegative().max(86_400_000).optional(),
}).superRefine((result, context) => {
  if (result.personalNonacceptance && (result.inferenceSource?.kind !== 'chatgpt'
    || result.finishReason !== 'error' || result.content !== null || result.toolCalls.length !== 0
    || result.usage.inputTokens !== null || result.usage.outputTokens !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Nonacceptance cannot contain generated output or usage.' })
  }
})
export type LocalInferenceResult = z.infer<typeof LocalInferenceResultSchema>

/** A host claims one attempt per request, under the poll token its local
 * coordinator reserved; the token is what makes a lost answer replayable. */
export const LocalInferenceAttemptPollSchema = z.object({
  requestId: z.string().uuid(), inferenceSource: ExecutorInferenceSourceSchema.optional(),
}).strict()
export type LocalInferenceAttemptPoll = z.infer<typeof LocalInferenceAttemptPollSchema>

/** Sent once as a host starts the model: it marks the attempt accepted and
 * answers its state. Cancel and fence afterwards are pushed as `control`. */
export const LocalInferenceAttemptControlSchema = z.object({
  attemptId: z.string().uuid(),
  dispatchFence: z.number().int().positive(),
}).strict()
export type LocalInferenceAttemptControl = z.infer<typeof LocalInferenceAttemptControlSchema>

/** A process-bound host sends this on orderly exit so presence becomes offline
 * immediately; an old epoch cannot disconnect a newly claimed host. */
export const LocalInferenceGoodbyeSchema = z.object({
  reason: z.enum(['desktop_exit', 'executor_shutdown']),
  receipt: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type LocalInferenceGoodbye = z.infer<typeof LocalInferenceGoodbyeSchema>

/** An opaque, one-use challenge is the only input to a connection claim. */
export const LocalInferenceDaemonChallengeSchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  expiresAt: TimestampSchema,
})

export const LocalInferenceDaemonConnectionSchema = z.object({
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  serverTime: TimestampSchema,
})

/**
 * An already-paired executor asks for its one local-inference host record
 * through its daemon key.  This is deliberately not an enrollment API: it
 * neither accepts a host label nor lets the daemon choose a custodian.
 */
export const LocalInferenceExecutorHostRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  executorId: z.string().uuid(),
  observedAt: TimestampSchema,
  signature: LocalInferenceMachineSignatureSchema,
}).strict()
export type LocalInferenceExecutorHostRequest = z.infer<
  typeof LocalInferenceExecutorHostRequestSchema
>

export const LocalInferenceExecutorHostSchema = z.object({
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  hostId: z.string().uuid(),
  organizationId: z.string().uuid(),
}).strict()
export type LocalInferenceExecutorHost = z.infer<typeof LocalInferenceExecutorHostSchema>

const LocalInferenceFrameDataSchema = z.string()
  .min(1)
  .max(21_848) // base64url encoding of a 16 KiB frame
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((value) => value.length % 4 !== 1, 'Invalid base64url frame encoding')
  .refine((value) => Math.floor(value.length * 3 / 4) <= 16 * 1024, 'Frame exceeds decoded limit')

/** A frame is relayed to a watching worker and never stored; `final` marks
 * the last frame of an attempt's stream. The sealed receipt is the capture. */
export const LocalInferenceAttemptFrameSchema = z.object({
  attemptId: z.string().uuid(),
  data: LocalInferenceFrameDataSchema,
  dispatchFence: z.number().int().positive(),
  final: z.boolean(),
  sequence: z.number().int().positive(),
}).strict()
export type LocalInferenceAttemptFrame = z.infer<typeof LocalInferenceAttemptFrameSchema>

export const LocalInferenceAttemptResultReceiptSchema = z.object({
  attemptId: z.string().uuid(),
  dispatchFence: z.number().int().positive(),
  result: LocalInferenceResultSchema,
}).strict()
export type LocalInferenceAttemptResultReceipt = z.infer<
  typeof LocalInferenceAttemptResultReceiptSchema
>

/** JSON limits are enforced before the encrypted payload is persisted. */
export const LOCAL_INFERENCE_MAX_REQUEST_BYTES = 2 * 1024 * 1024
export const LOCAL_INFERENCE_MAX_RESULT_BYTES = 512 * 1024
export const LOCAL_INFERENCE_MAX_FRAME_BYTES = 16 * 1024

export const assertLocalInferenceSerializedSize = (
  value: unknown,
  maximum: number,
): void => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) {
    throw new Error('Local inference protocol payload exceeds its bounded limit.')
  }
}

export const AgentAvailabilityProjectionSchema = z.object({
  /**
   * Source/computer detail is returned to its exact custodian in the selected team, and to a
   * teammate while that computer is shared with everyone in it (`sharedWithTeam`).
   */
  inference: z.object({ provider: z.enum(['local/ollama', 'executor/chatgpt']), source: ExecutorInferenceSourceSchema,
    hostId: z.string().uuid(), executorId: z.string().uuid().nullable(), computerLabel: NonEmptyStringSchema,
    modelName: NonEmptyStringSchema, sharedWithTeam: z.boolean().optional(),
  }).strict().optional(),
  availability: AgentAvailabilitySchema,
  reason: LocalInferenceAvailabilityReasonSchema,
  revision: z.number().int().nonnegative(),
  serverTime: TimestampSchema,
  validUntil: TimestampSchema,
})
export type AgentAvailabilityProjection = z.infer<typeof AgentAvailabilityProjectionSchema>

/**
 * The host's one outbound socket (`GET /api/local-inference/daemon/socket`).
 * The first message is `connect`: a one-use challenge signed for the current
 * connection epoch. Every later message is signed over `{ connectionId, body }`
 * with the `connected` answer's id, so a message signed for one connection
 * cannot be replayed on another, and the server keeps each purpose's sequence
 * for the connection in memory instead of writing it per message.
 */
export const LocalInferenceSocketRequestKindSchema = z.enum([
  'claim', 'accept', 'result', 'termination', 'heartbeat', 'resource',
])
export type LocalInferenceSocketRequestKind = z.infer<typeof LocalInferenceSocketRequestKindSchema>

/** The envelope purpose each socket message is signed for. */
export const LOCAL_INFERENCE_SOCKET_PURPOSE = {
  accept: 'control', claim: 'poll', frame: 'frames', heartbeat: 'heartbeat',
  resource: 'resource', result: 'result', termination: 'termination',
} as const satisfies Record<LocalInferenceSocketRequestKind | 'frame', LocalInferenceEnvelopePurpose>

export const LocalInferenceResourceSyncSchema = z.object({
  attachment: LocalInferenceResourceAttachmentSchema,
  controlRevision: z.number().int().nonnegative(),
  paused: z.boolean(),
  healthReason: z.enum(['termination_uncertain']).nullable(),
  action: z.enum(['pause', 'resume']).optional(),
}).strict()
export type LocalInferenceResourceSync = z.infer<typeof LocalInferenceResourceSyncSchema>

const SocketChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)

export const LocalInferenceHostSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connect'), challenge: SocketChallengeSchema, envelope: LocalInferenceSignedEnvelopeSchema,
  }).strict(),
  z.object({
    type: z.literal('request'), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: LocalInferenceSocketRequestKindSchema, body: z.unknown(), envelope: LocalInferenceSignedEnvelopeSchema,
  }).strict(),
  z.object({
    type: z.literal('frame'), frame: LocalInferenceAttemptFrameSchema, envelope: LocalInferenceSignedEnvelopeSchema,
  }).strict(),
])
export type LocalInferenceHostSocketMessage = z.infer<typeof LocalInferenceHostSocketMessageSchema>

export const LocalInferenceAttemptControlStateSchema = z.enum(['active', 'cancelled', 'expired', 'fenced'])
export type LocalInferenceAttemptControlState = z.infer<typeof LocalInferenceAttemptControlStateSchema>

export const LocalInferenceServerSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connected'), connectionId: z.string().uuid(),
    connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/), serverTime: TimestampSchema,
  }).strict(),
  z.object({ type: z.literal('response'), id: z.number().int().positive(), data: z.unknown() }).strict(),
  z.object({
    type: z.literal('error'), id: z.number().int().positive(),
    code: z.string().regex(/^[A-Z_]{1,64}$/), status: z.number().int().min(400).max(599),
  }).strict(),
  // Work was queued for this host, or for a sibling on the same physical
  // resource; only the addressed host claims, the sibling holds no slot.
  z.object({
    type: z.literal('attempt_available'), hostId: z.string().uuid(), resourceId: z.string().uuid().nullable(),
  }).strict(),
  z.object({
    type: z.literal('control'), attemptId: z.string().uuid(),
    state: LocalInferenceAttemptControlStateSchema.exclude(['active']),
  }).strict(),
])
export type LocalInferenceServerSocketMessage = z.infer<typeof LocalInferenceServerSocketMessageSchema>

/** Socket close codes a host treats as a refusal, never as a lost connection. */
export const LOCAL_INFERENCE_SOCKET_REFUSED = 4401
/** Another live connection holds this host and epoch; the host claims afresh. */
export const LOCAL_INFERENCE_SOCKET_REPLACED = 4409

/** Content-free proof of an already-stored original result; never a replacement result or new admission. */
export const PersonalInferenceReceiptStatusSchema = z.object({
  acknowledged: z.literal(true), resultDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict()
export type PersonalInferenceReceiptStatus = z.infer<typeof PersonalInferenceReceiptStatusSchema>
