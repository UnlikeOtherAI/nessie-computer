import { z } from 'zod'

import { ExecutorDaemonSignatureSchema, ExecutorIdSchema } from './executor.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * Team names without a person (contract §13). A computer asks Nessie for the
 * organisation and team names of its paired executors in one batch per Nessie
 * server: `POST /api/executor-daemon/teams`. Each entry proves one executor
 * with that executor's own machine key, signed under
 * `EXECUTOR_DAEMON_TEAMS_SIGNATURE_DOMAIN` over `{ executorId, observedAt }`
 * (the entry without its signature). No daemon connection, person or session
 * is involved, so the command line and the apps can ask while a team's daemon
 * is stopped.
 *
 * Nessie resolves the names itself (UOA's public team lookup for a UOA-bound
 * team, its own names otherwise) and answers display names only. An entry it
 * cannot verify, or an executor it no longer knows, is left out of the answer
 * rather than refused, so one stale team never hides the others.
 *
 * The computer keeps the answer as a display-only label: it never grants,
 * narrows or proves access.
 */
export const EXECUTOR_DAEMON_TEAMS_PATH = '/api/executor-daemon/teams'

/** The domain each entry's signature is made under (`canonicalExecutorPayload`). */
export const EXECUTOR_DAEMON_TEAMS_SIGNATURE_DOMAIN = 'nessie.executor.daemon.teams.v1'

/** At most this many executors in one request (and one answer). */
export const EXECUTOR_DAEMON_TEAMS_MAXIMUM = 32

export const ExecutorDaemonTeamsEntrySchema = z.object({
  executorId: ExecutorIdSchema,
  observedAt: TimestampSchema,
  signature: ExecutorDaemonSignatureSchema,
}).strict()
export type ExecutorDaemonTeamsEntry = z.infer<typeof ExecutorDaemonTeamsEntrySchema>

export const ExecutorDaemonTeamsRequestSchema = z.object({
  entries: z.array(ExecutorDaemonTeamsEntrySchema).min(1).max(EXECUTOR_DAEMON_TEAMS_MAXIMUM)
    .refine((entries) => new Set(entries.map((entry) => entry.executorId)).size === entries.length,
      'Each executor appears once.'),
}).strict()
export type ExecutorDaemonTeamsRequest = z.infer<typeof ExecutorDaemonTeamsRequestSchema>

const TeamDisplayNameSchema = z.string().trim().min(1).max(160)

/** One executor's names. A pairing made for the whole organisation has no team, so no team name. */
export const ExecutorDaemonTeamNamesSchema = z.object({
  executorId: ExecutorIdSchema,
  organizationName: TeamDisplayNameSchema,
  teamName: TeamDisplayNameSchema.nullable(),
}).strict()
export type ExecutorDaemonTeamNames = z.infer<typeof ExecutorDaemonTeamNamesSchema>

export const ExecutorDaemonTeamsResponseSchema = z.object({
  teams: z.array(ExecutorDaemonTeamNamesSchema).max(EXECUTOR_DAEMON_TEAMS_MAXIMUM),
}).strict()
export type ExecutorDaemonTeamsResponse = z.infer<typeof ExecutorDaemonTeamsResponseSchema>
