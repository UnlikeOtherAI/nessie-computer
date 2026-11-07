import { z } from 'zod'

const percent = z.number().finite().min(0).max(100)
const bytes = z.number().finite().nonnegative()
const time = z.string().datetime()

export const EXECUTOR_MONITOR_VIEW_TTL_MS = 15_000
export const EXECUTOR_MONITOR_UPLOAD_INTERVAL_MS = 5_000
export const EXECUTOR_MONITOR_HISTORY_MS = 60_000

/** A short renewable viewing lease; it authorizes no commands or credentials. */
export const ExecutorMonitorRequestSchema = z.object({ expiresAt: time }).strict()
export type ExecutorMonitorRequest = z.infer<typeof ExecutorMonitorRequestSchema>

export const ExecutorUsageWindowSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(['session', 'weekly', 'monthly', 'other']),
  label: z.string().min(1).max(100).optional(),
  remainingPercent: percent,
  durationMinutes: z.number().positive().optional(),
  resetsAt: time.nullable(),
}).strict()

/** Derived provider facts only. Tokens, credential paths and raw provider responses never travel. */
export const ExecutorSubscriptionSchema = z.object({
  provider: z.enum(['claude', 'codex', 'kimi', 'grok']),
  status: z.enum(['ready', 'not_installed', 'signed_out', 'unavailable', 'unsupported']),
  account: z.string().max(254).nullable(),
  /** Opaque identity or credential fingerprint; unknown accounts must never merge by plan or quota. */
  accountKey: z.string().max(100).optional(),
  workspaceKey: z.string().max(100).optional(),
  source: z.enum(['cli', 'kimi_api', 'sysmon']).optional(),
  plan: z.string().max(100).nullable(),
  checkedAt: time,
  windows: z.array(ExecutorUsageWindowSchema).max(16),
}).strict()

/** Only derived, owner-visible GitHub facts; no repository contents or credentials. */
export const ExecutorMonitorCiSchema = z.object({
  status: z.enum(['ready', 'signed_out', 'not_installed', 'unavailable']),
  checkedAt: time,
  truncated: z.boolean(),
  pullRequests: z.array(z.object({
    repository: z.string().min(1).max(200), number: z.number().int().positive(),
    title: z.string().max(300), url: z.string().url().startsWith('https://github.com/'),
  }).strict()).max(30),
}).strict()

export const ExecutorMonitorSnapshotSchema = z.object({
  capturedAt: time,
  os: z.enum(['windows', 'macos', 'linux']),
  processor: z.string().max(200),
  hostname: z.string().max(200).optional(),
  address: z.string().max(100).nullable().optional(),
  cores: z.number().int().positive().optional(),
  load: z.number().finite().nonnegative().nullable().optional(),
  cpu: percent.nullable(),
  gpu: percent.nullable(),
  gpuMemoryUsedBytes: bytes.nullable().optional(),
  gpuMemoryTotalBytes: bytes.positive().nullable().optional(),
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
  ci: ExecutorMonitorCiSchema.optional(),
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
