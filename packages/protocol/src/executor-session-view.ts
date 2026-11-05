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

export const ExecutorSessionViewFrameSchema = ExecutorSessionViewRequestSchema.extend({
  screen: ExecutorSessionScreenSchema.nullable(),
}).strict()

export const ExecutorSessionViewExchangeSchema = z.object({
  executorId: z.string().uuid(),
  connectionEpoch: z.string().regex(/^\d+$/),
  observedAt: z.string().datetime(),
  frames: z.array(ExecutorSessionViewFrameSchema).max(8),
  sessions: z.array(ExecutorCodingSessionSummarySchema).max(32).optional(),
  signature: z.string().min(1).max(256),
}).strict()
export type ExecutorSessionViewExchange = z.infer<typeof ExecutorSessionViewExchangeSchema>

export const ExecutorSessionViewOffersSchema = z.object({
  requests: z.array(ExecutorSessionViewRequestSchema).max(8),
}).strict()

export const ExecutorSessionViewResponseSchema = z.object({
  screen: ExecutorSessionScreenSchema.nullable(),
  online: z.boolean(),
  session: ExecutorCodingSessionSummarySchema.omit({ ownerKey: true }),
  canShare: z.boolean(),
}).strict()

const HostSessionSummarySchema = ExecutorCodingSessionSummarySchema.omit({ ownerKey: true })
export const ExecutorHostSessionListSchema = z.array(HostSessionSummarySchema.extend({
  executorId: z.string().uuid(), executorLabel: z.string(), shared: z.boolean(),
}).strict()).max(200)

export const ExecutorSessionSharesSchema = z.array(z.object({
  userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string(),
}).strict())
