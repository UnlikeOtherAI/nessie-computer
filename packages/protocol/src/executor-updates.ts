import { z } from 'zod'

const Version = z.string().regex(/^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})$/u)

/** Public software status only: no local paths, credentials or release URLs. */
export const ExecutorUpdatePhaseSchema = z.enum([
  'idle', 'checking', 'available', 'downloading', 'waiting', 'installing', 'restarting', 'failed', 'unsupported',
])
export const ExecutorSoftwareStatusSchema = z.object({
  format: z.literal(1),
  installedVersion: z.string().min(1).max(64),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  availableVersion: Version.optional(),
  targetVersion: Version.optional(),
  automatic: z.boolean(),
  channel: z.enum(['stable', 'preview']),
  phase: ExecutorUpdatePhaseSchema,
  canInstall: z.boolean(),
  draining: z.boolean().optional(),
  lastCheckedAt: z.string().datetime().optional(),
  code: z.string().regex(/^update\.[a-z_]{1,64}$/u).optional(),
  requestId: z.string().uuid().optional(),
}).strict()
export type ExecutorSoftwareStatus = z.infer<typeof ExecutorSoftwareStatusSchema>

/** Notification policy stays local; the heartbeat carries only software status. */
export const ExecutorLocalUpdateStatusSchema = ExecutorSoftwareStatusSchema.extend({ notify: z.boolean() })
export type ExecutorLocalUpdateStatus = z.infer<typeof ExecutorLocalUpdateStatusSchema>

/** Requesting an install cannot choose executable code, change channels or change policy. */
export const ExecutorSoftwareUpdateRequestSchema = z.object({
  requestId: z.string().uuid(),
  requestedAt: z.string().datetime(),
}).strict()
export type ExecutorSoftwareUpdateRequest = z.infer<typeof ExecutorSoftwareUpdateRequestSchema>

/** Local UI/CLI operations. The native coordinator owns release selection and authorization. */
export const ExecutorLocalUpdateRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('check') }).strict(),
  z.object({ operation: z.literal('install') }).strict(),
  z.object({ operation: z.literal('automatic'), enabled: z.boolean() }).strict(),
  z.object({ operation: z.literal('remind') }).strict(),
  z.object({ operation: z.literal('channel'), channel: z.enum(['stable', 'preview']) }).strict(),
])
export type ExecutorLocalUpdateRequest = z.infer<typeof ExecutorLocalUpdateRequestSchema>
