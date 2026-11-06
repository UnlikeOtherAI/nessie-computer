import { z } from 'zod'

const percent = z.number().finite().min(0).max(100)
const bytes = z.number().finite().nonnegative()
const time = z.string().datetime()

export const ExecutorUsageWindowSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['session', 'weekly', 'monthly', 'other']),
  remainingPercent: percent,
  durationMinutes: z.number().positive().optional(),
  resetsAt: time.nullable(),
}).strict()

/** Derived provider facts only. Tokens, credential paths and raw provider responses never travel. */
export const ExecutorSubscriptionSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  status: z.enum(['ready', 'not_installed', 'signed_out', 'unavailable', 'unsupported']),
  account: z.string().max(254).nullable(),
  plan: z.string().max(100).nullable(),
  checkedAt: time,
  windows: z.array(ExecutorUsageWindowSchema).max(16),
}).strict()

export const ExecutorMonitorSnapshotSchema = z.object({
  capturedAt: time,
  os: z.enum(['windows', 'macos', 'linux']),
  processor: z.string().max(200),
  cpu: percent.nullable(),
  gpu: percent.nullable(),
  history: z.array(z.object({ at: time, cpu: percent.nullable(), gpu: percent.nullable() }).strict()).max(24),
  memoryUsedBytes: bytes,
  memoryTotalBytes: bytes.positive(),
  diskUsedBytes: bytes.nullable(),
  diskTotalBytes: bytes.positive().nullable(),
  uptimeSeconds: z.number().nonnegative(),
  processes: z.array(z.object({
    pid: z.number().int().nonnegative(), name: z.string().max(200),
    cpu: z.number().finite().nonnegative().nullable(), memoryBytes: bytes.nullable(),
  }).strict()).max(10),
  subscriptions: z.array(ExecutorSubscriptionSchema).max(16),
}).strict()

export const ExecutorMonitorViewSchema = z.object({
  online: z.boolean(),
  stale: z.boolean(),
  subscriptionsVisible: z.boolean(),
  snapshot: ExecutorMonitorSnapshotSchema.nullable(),
}).strict()

export type ExecutorMonitorSnapshot = z.infer<typeof ExecutorMonitorSnapshotSchema>
export type ExecutorSubscription = z.infer<typeof ExecutorSubscriptionSchema>
export type ExecutorUsageWindow = z.infer<typeof ExecutorUsageWindowSchema>
