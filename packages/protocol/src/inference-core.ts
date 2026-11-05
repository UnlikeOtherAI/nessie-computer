import { z } from 'zod'
import { ExecutorInferenceSourceSchema } from './personal-inference-authority.js'
import { ResponsesContinuationSchema } from './responses-continuation.js'

import { AuthorizedActionContextSchema } from './access-context.js'
import { InferenceCredentialBindingIdSchema, InferenceRoutingProfileIdSchema } from './ids.js'
import { OperationTypeSchema, TokenUsageSchema } from './ledger.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// ─── Phase 2: Inference Connector And Orchestration ───────────────────────

export const ToolCallingModeSchema = z.enum([
  'native',
  'prompt-translated',
  'disabled',
])
export type ToolCallingMode = z.infer<typeof ToolCallingModeSchema>

export const StructuredOutputModeSchema = z.enum([
  'native-json',
  'prompt-json',
  'text-only',
])
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>

export const SystemPromptModeSchema = z.enum(['native', 'fold-into-user'])
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>

export const ToolResultModeSchema = z.enum([
  'native-tool-message',
  'context-block',
])
export type ToolResultMode = z.infer<typeof ToolResultModeSchema>

export const ProviderHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const NormalizedFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool-call',
  'content-filter',
  'error',
  'other',
])
export type NormalizedFinishReason = z.infer<typeof NormalizedFinishReasonSchema>

export const ProviderMessageContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    imageUrl: z.string().url(),
  }),
])
export type ProviderMessageContentPart = z.infer<
  typeof ProviderMessageContentPartSchema
>

export const ProviderMessageRoleSchema = z.enum([
  'system',
  'user',
  'assistant',
  'tool',
])
export type ProviderMessageRole = z.infer<typeof ProviderMessageRoleSchema>

const ProviderMessageContentSchema = z.union([
  z.string(),
  z.array(ProviderMessageContentPartSchema),
])

export const ProviderToolCallSchema = z.object({
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>

export const ProviderMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('user'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('assistant'),
    content: ProviderMessageContentSchema.nullable(),
    toolCalls: z.array(ProviderToolCallSchema).optional(),
    // Provider reasoning replayed on later turns where the dialect requires it
    // (DeepSeek's tool rounds). Optional here so a checkpoint written before
    // the field existed still parses.
    reasoning: z.string().optional(),
    responsesContinuation: ResponsesContinuationSchema.optional(),
    historicalContext: z.enum(['assistant', 'application_notice']).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: NonEmptyStringSchema,
  }),
])
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>

export const ToolSchemaDescriptorSchema = z.object({
  toolName: NonEmptyStringSchema,
  description: z.string(),
  inputSchema: z.record(z.unknown()),
})
export type ToolSchemaDescriptor = z.infer<typeof ToolSchemaDescriptorSchema>

export const ToolCallIntentSchema = z.object({
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ToolCallIntent = z.infer<typeof ToolCallIntentSchema>

export const StructuredOutputDescriptorSchema = z.object({
  name: NonEmptyStringSchema,
  jsonSchema: z.record(z.unknown()),
})
export type StructuredOutputDescriptor = z.infer<
  typeof StructuredOutputDescriptorSchema
>

export const JsonObjectResponseFormatSchema = z.object({
  type: z.literal('json_object'),
})
export type JsonObjectResponseFormat = z.infer<
  typeof JsonObjectResponseFormatSchema
>

export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: NonEmptyStringSchema,
    }),
  }),
])
export type ToolChoice = z.infer<typeof ToolChoiceSchema>

export const ModelCapabilitySourceSchema = z.enum(['static', 'live', 'manual'])
export type ModelCapabilitySource = z.infer<typeof ModelCapabilitySourceSchema>

export const CapabilityResolutionSourceSchema = z.enum([
  'override',
  'static',
  'live',
  'manual',
])
export type CapabilityResolutionSource = z.infer<
  typeof CapabilityResolutionSourceSchema
>

export const ModelCapabilityUsageReportingSchema = z.object({
  inputTokens: z.boolean(),
  outputTokens: z.boolean(),
  cachedInputTokens: z.boolean(),
  cachedOutputTokens: z.boolean(),
  cacheReadTokens: z.boolean(),
  cacheWriteTokens: z.boolean(),
  providerReportedCost: z.boolean(),
})
export type ModelCapabilityUsageReporting = z.infer<
  typeof ModelCapabilityUsageReportingSchema
>

export const ModelCapabilitySnapshotSchema = z.object({
  inferenceSource: ExecutorInferenceSourceSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema.optional(),
  supportsModelDiscovery: z.boolean(),
  supportsChat: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsEmbeddings: z.boolean(),
  supportsVision: z.boolean(),
  toolCallingMode: ToolCallingModeSchema,
  structuredOutputMode: StructuredOutputModeSchema,
  systemPromptMode: SystemPromptModeSchema,
  toolResultMode: ToolResultModeSchema,
  usageReporting: ModelCapabilityUsageReportingSchema,
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  source: ModelCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
})
export type ModelCapabilitySnapshot = z.infer<typeof ModelCapabilitySnapshotSchema>

export const CapabilityResolutionSchema = z.object({
  effectiveSnapshot: ModelCapabilitySnapshotSchema,
  effectiveSource: CapabilityResolutionSourceSchema,
  overrideActive: z.boolean(),
})
export type CapabilityResolution = z.infer<typeof CapabilityResolutionSchema>

export const InvocationUsageSchema = TokenUsageSchema
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>

export const InvocationOperationTypeSchema = OperationTypeSchema
export type InvocationOperationType = z.infer<typeof InvocationOperationTypeSchema>

export const InvocationRecordSchema = z.object({
  invocationId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: InvocationOperationTypeSchema,
  usage: InvocationUsageSchema,
  providerReportedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  latencyMs: z.number().int().nonnegative(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type InvocationRecord = z.infer<typeof InvocationRecordSchema>

export const ProviderInvocationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema,
  messages: z.array(ProviderMessageSchema),
  tools: z.array(ToolSchemaDescriptorSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: JsonObjectResponseFormatSchema.optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type ProviderInvocationRequest = z.infer<
  typeof ProviderInvocationRequestSchema
>

export const ProviderInvocationResultSchema = z.object({
  outputText: z.string(),
  reasoningText: z.string().optional(),
  toolCalls: z.array(ProviderToolCallSchema),
  structuredOutput: z.unknown().optional(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  invocation: InvocationRecordSchema,
})
export type ProviderInvocationResult = z.infer<
  typeof ProviderInvocationResultSchema
>

export const ProviderStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('reasoning_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('output_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call.delta'),
    index: z.number().int().nonnegative(),
    id: z.string(),
    toolName: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('response.error'),
    message: z.string(),
    retryable: z.boolean(),
  }),
])
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>

export const InferenceRequestRouteSchema = z.union([
  z
    .object({
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      routingProfileId: InferenceRoutingProfileIdSchema,
    })
    .strict(),
])
export type InferenceRequestRoute = z.infer<typeof InferenceRequestRouteSchema>

export const InferenceRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  actorContext: AuthorizedActionContextSchema,
  route: InferenceRequestRouteSchema,
  messages: z.array(ProviderMessageSchema),
  tools: z.array(ToolSchemaDescriptorSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: JsonObjectResponseFormatSchema.optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>

export const ProviderHealthReportSchema = z.object({
  status: ProviderHealthStatusSchema,
  checkedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
})
export type ProviderHealthReport = z.infer<typeof ProviderHealthReportSchema>

export const ProviderConnectorMetaSchema = z.object({
  provider: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  supportsModelDiscovery: z.boolean(),
})
export type ProviderConnectorMeta = z.infer<typeof ProviderConnectorMetaSchema>

export const ProviderConnectionConfigSchema = z.object({
  providerKey: NonEmptyStringSchema,
  baseUrl: z.string().url().optional(),
  credentialBindingId: InferenceCredentialBindingIdSchema.optional(),
})
export type ProviderConnectionConfig = z.infer<
  typeof ProviderConnectionConfigSchema
>
