import { z } from 'zod'

import { createUuidBrandSchema, TimestampSchema } from './schema-primitives.js'

/** The exact delivered command a signed control poll asks to cancel. No arguments leave the machine again. */
export const ExecutorCommandCancellationTargetSchema = z.object({
  argumentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bindingFence: z.string().regex(/^\d+$/),
  bindingId: createUuidBrandSchema<'ExecutorBindingId'>(),
  capabilityRevision: z.number().int().positive(),
  commandId: createUuidBrandSchema<'ExecutorCommandId'>(),
  expiresAt: TimestampSchema,
  idempotencyKey: z.string().min(1).max(255),
}).strict()
export type ExecutorCommandCancellationTarget = z.infer<typeof ExecutorCommandCancellationTargetSchema>

/** Delivered only in answer to a signed poll naming this exact command. */
export const ExecutorCommandCancellationSchema = ExecutorCommandCancellationTargetSchema.extend({
  requestedAt: TimestampSchema,
}).strict()
export type ExecutorCommandCancellation = z.infer<typeof ExecutorCommandCancellationSchema>

/** The terminal result is sent through the existing signed, digest-bound receipt. */
export const EXECUTOR_COMMAND_CANCELLED_RESULT = Object.freeze({
  code: 'EXECUTOR_COMMAND_CANCELLED',
  status: 'cancelled',
  success: false,
})
