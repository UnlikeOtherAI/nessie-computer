import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TaskIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  TokenLedgerEventIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// ─── Phase 2: Token Ledger ─────────────────────────────────────────────────

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedOutputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const OperationTypeSchema = z.enum([
  'chat',
  'completion',
  'embedding',
  'translation',
  'reasoning',
  'tool-translation',
  'other',
])
export type OperationType = z.infer<typeof OperationTypeSchema>

export const PricingSourceSchema = z.enum([
  'provider-default',
  'org-override',
  'team-override',
  'manual',
])
export type PricingSource = z.infer<typeof PricingSourceSchema>

export const PricingSnapshotSchema = z.object({
  profileId: NonEmptyStringSchema,
  source: PricingSourceSchema,
  currency: NonEmptyStringSchema,
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  cachedOutputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
})
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>

export const TokenLedgerEventResponseSchema = z.object({
  eventId: TokenLedgerEventIdSchema,
  occurredAt: TimestampSchema,
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  actorId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: OperationTypeSchema,
  usage: TokenUsageSchema,
  providerReportedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  pricingSnapshot: PricingSnapshotSchema.optional(),
  estimatedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type TokenLedgerEventResponse = z.infer<typeof TokenLedgerEventResponseSchema>

export const TokenUsageSummarySchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalEstimatedCost: z.number().nonnegative(),
  totalProviderReportedCost: z.number().nonnegative(),
  currency: NonEmptyStringSchema,
  breakdowns: z.array(
    z.object({
      key: NonEmptyStringSchema,
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      estimatedCost: z.number().nonnegative(),
      providerReportedCost: z.number().nonnegative(),
    }),
  ),
})
export type TokenUsageSummary = z.infer<typeof TokenUsageSummarySchema>

export const MonthlyEstimateSchema = z.object({
  currentMonthUsage: z.number().nonnegative(),
  currentMonthCost: z.number().nonnegative(),
  projectedMonthlyCost: z.number().nonnegative(),
  currency: NonEmptyStringSchema,
  daysElapsed: z.number().int().positive(),
  daysInMonth: z.number().int().positive(),
})
export type MonthlyEstimate = z.infer<typeof MonthlyEstimateSchema>
