import { z } from 'zod'

import { ExecutorCodingSessionOwnerKeySchema, ExecutorCodingSessionSummarySchema } from './executor-coding-sessions.js'

export const EXECUTOR_TERMINAL_COLS = 120
export const EXECUTOR_TERMINAL_ROWS = 36
export const EXECUTOR_TERMINAL_SCROLLBACK = 500

/** A complete replayable screen, never an escape sequence cut in half. */
export const ExecutorSessionScreenSchema = z.object({
  ansi: z.string().max(256_000),
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(80),
  capturedAt: z.string().datetime(),
  kind: z.enum(['terminal', 'activity']),
}).strict()
export type ExecutorSessionScreen = z.infer<typeof ExecutorSessionScreenSchema>

export const ExecutorSessionViewRequestSchema = z.object({
  sessionId: z.string().uuid(),
  ownerKey: ExecutorCodingSessionOwnerKeySchema,
}).strict()
export type ExecutorSessionViewRequest = z.infer<typeof ExecutorSessionViewRequestSchema>

export const ExecutorSessionMessageSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  at: z.string().datetime().nullable(),
  parts: z.array(z.object({
    kind: z.enum(['text', 'thinking', 'tool_call', 'tool_result']),
    text: z.string().max(16_000),
    name: z.string().max(160).optional(),
  }).strict()).max(32),
}).strict()

export const ExecutorSessionConversationSchema = z.object({
  messages: z.array(ExecutorSessionMessageSchema).max(200),
  truncated: z.boolean(),
  capturedAt: z.string().datetime(),
  sendMode: z.enum(['managed', 'queue', 'push']).nullable(),
  canInterrupt: z.boolean(),
}).strict()
export type ExecutorSessionConversation = z.infer<typeof ExecutorSessionConversationSchema>
export type ExecutorSessionMessage = z.infer<typeof ExecutorSessionMessageSchema>

export const ExecutorSessionViewFrameSchema = ExecutorSessionViewRequestSchema.extend({
  screen: ExecutorSessionScreenSchema.nullable(),
  conversation: ExecutorSessionConversationSchema.nullable().optional(),
}).strict()

export const ExecutorSessionInventorySchema = z.object({
  id: z.string().uuid(), observedAt: z.string().datetime(), complete: z.boolean(),
}).strict()

export const ExecutorSessionInventoryPageSchema = z.object({
  sessions: z.array(ExecutorCodingSessionSummarySchema).max(32),
  inventory: ExecutorSessionInventorySchema,
  nextCursor: z.string().max(100).nullable(),
}).strict()
export type ExecutorSessionInventoryPage = z.infer<typeof ExecutorSessionInventoryPageSchema>

export const ExecutorSessionActionBodySchema = z.object({
  id: z.string().uuid(), kind: z.enum(['managed', 'queue', 'push', 'interrupt']),
  message: z.string().min(1).max(32_000).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind !== 'interrupt') !== Boolean(value.message?.trim())) {
    ctx.addIssue({ code: 'custom', message: 'A message is required only for sending input.' })
  }
})
export const ExecutorSessionActionSchema = ExecutorSessionViewRequestSchema.extend({
  id: z.string().uuid(), kind: z.enum(['managed', 'queue', 'push', 'interrupt']),
  message: z.string().min(1).max(32_000).optional(), expiresAt: z.string().datetime(),
}).strict()
export const ExecutorSessionActionReceiptSchema = z.object({
  id: z.string().uuid(), state: z.enum(['accepted', 'failed', 'outcome_unknown']),
  code: z.string().regex(/^[a-z0-9_]{1,100}$/u),
}).strict()
export const ExecutorSessionActionStatusSchema = z.object({
  id: z.string().uuid(), state: z.enum(['pending', 'accepted', 'failed', 'outcome_unknown', 'expired']),
  code: z.string().nullable(),
}).strict()
export type ExecutorSessionAction = z.infer<typeof ExecutorSessionActionSchema>
export type ExecutorSessionActionReceipt = z.infer<typeof ExecutorSessionActionReceiptSchema>
export type ExecutorSessionActionBody = z.infer<typeof ExecutorSessionActionBodySchema>

export const ExecutorSessionViewExchangeSchema = z.object({
  executorId: z.string().uuid(),
  connectionEpoch: z.string().regex(/^\d+$/),
  observedAt: z.string().datetime(),
  frames: z.array(ExecutorSessionViewFrameSchema).max(8),
  sessions: z.array(ExecutorCodingSessionSummarySchema).max(32).optional(),
  inventory: ExecutorSessionInventorySchema.optional(),
  receipts: z.array(ExecutorSessionActionReceiptSchema).max(8).optional(),
  signature: z.string().min(1).max(256),
}).strict()
export type ExecutorSessionViewExchange = z.infer<typeof ExecutorSessionViewExchangeSchema>

export const ExecutorSessionViewOffersSchema = z.object({
  requests: z.array(ExecutorSessionViewRequestSchema).max(8),
  actions: z.array(ExecutorSessionActionSchema).max(8).optional(),
}).strict()

export const ExecutorSessionViewResponseSchema = z.object({
  screen: ExecutorSessionScreenSchema.nullable(),
  conversation: ExecutorSessionConversationSchema.nullable().optional(),
  online: z.boolean(),
  session: ExecutorCodingSessionSummarySchema.omit({ ownerKey: true }),
  canShare: z.boolean(),
  canInteract: z.boolean().optional(),
}).strict()

const HostSessionSummarySchema = ExecutorCodingSessionSummarySchema.omit({ ownerKey: true })
export const ExecutorHostSessionListSchema = z.array(HostSessionSummarySchema.extend({
  executorId: z.string().uuid(), executorLabel: z.string(), shared: z.boolean(),
}).strict()).max(200)

export const ExecutorSessionSharesSchema = z.array(z.object({
  userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string(),
}).strict())
