import { z } from 'zod'

import { ExecutorDaemonSignatureSchema, ExecutorIdSchema } from './executor.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * "Who can send work here": what one paired team lets reach this computer,
 * read by the computer's own app so its owner can see it beside what the
 * computer allows. The daemon asks with its signed connection; Nessie answers
 * from the computer's current grants inside the paired team, resolving names
 * at read time (people through UOA). The computer keeps the answer in memory
 * only — it is a view, never an authority and never a cache that grants access.
 */
export const ExecutorDaemonAudienceRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonAudienceRequest = z.infer<typeof ExecutorDaemonAudienceRequestSchema>

const AudienceNameSchema = z.string().trim().min(1).max(160)

export const EXECUTOR_AUDIENCE_NAMED_MAXIMUM = 50

export const ExecutorDaemonAudienceResponseSchema = z.object({
  /** Agents that may send work to this computer, by display name. */
  agents: z.array(z.object({ id: z.string().min(1).max(64), name: AudienceNameSchema }).strict())
    .max(EXECUTOR_AUDIENCE_NAMED_MAXIMUM),
  /** True when the computer is shared with the whole team. */
  everyoneInTeam: z.boolean(),
  /** People it is shared with directly (the owner included), by display name. */
  people: z.array(z.object({ name: AudienceNameSchema, isOwner: z.boolean() }).strict())
    .max(EXECUTOR_AUDIENCE_NAMED_MAXIMUM),
  /** How many people in total, when `people` is truncated. */
  peopleCount: z.number().int().nonnegative(),
  /** Projects whose members may use it. */
  projects: z.array(z.object({ id: z.string().min(1).max(64), name: AudienceNameSchema }).strict())
    .max(EXECUTOR_AUDIENCE_NAMED_MAXIMUM),
  /** When Nessie answered. */
  observedAt: TimestampSchema,
}).strict()
export type ExecutorDaemonAudienceResponse = z.infer<typeof ExecutorDaemonAudienceResponseSchema>
