import { z } from 'zod'

import { ExecutorCommandCancellationSchema, ExecutorCommandCancellationTargetSchema } from './executor-cancellation.js'
import { createUuidBrandSchema } from './schema-primitives.js'

/**
 * Sessions and concurrent commands (contract §11, `docs/sessions-and-concurrency.md`).
 *
 * Every piece of work an agent run does on a computer belongs to one session,
 * which Nessie opens and closes. A daemon that sends `concurrency: 1` on its
 * command poll takes several commands at once and runs them side by side; a
 * daemon that does not keeps the one-command-at-a-time shape, and Nessie keeps
 * serving it. These are the pieces both sides share; the poll request and
 * answer that carry them are in `executor.ts`.
 */

/** Nessie's executor session (`ExecutorSessionSummaryResponse.id`), which a run's commands now carry. */
export const ExecutorSessionIdSchema = createUuidBrandSchema<'ExecutorSessionId'>()
export type ExecutorSessionId = z.infer<typeof ExecutorSessionIdSchema>

/** The concurrency protocol version a daemon speaks. Only 1 exists. */
export const EXECUTOR_COMMAND_CONCURRENCY_VERSION = 1 as const

/** How many commands one concurrent poll answer may hand out, and how many a poll may name as active. */
export const EXECUTOR_CONCURRENT_COMMANDS_MAXIMUM = 64
export const EXECUTOR_ACTIVE_COMMANDS_MAXIMUM = 256
export const EXECUTOR_SESSION_CLOSE_MAXIMUM = 64
/** The longest agent display name a command may carry, for the owner's program request. */
export const EXECUTOR_AGENT_NAME_MAX_CHARS = 120

/**
 * What a command uses on the computer, for capacity. Nessie counts the same
 * way when it fills the free slots a poll reports, so the mapping lives here.
 */
export const EXECUTOR_COMMAND_CAPACITY_KINDS = ['file', 'program', 'coding', 'browser', 'mcp'] as const
export const ExecutorCommandCapacityKindSchema = z.enum(EXECUTOR_COMMAND_CAPACITY_KINDS)
export type ExecutorCommandCapacityKind = z.infer<typeof ExecutorCommandCapacityKindSchema>

/**
 * The capacity kind of an operation, or `null` for `sandbox.stop`: a stop
 * only ends work, so it never waits for a slot and Nessie sends it whatever
 * the poll says is free. An operation this version does not know is `null`
 * too; the daemon refuses it on its own.
 */
export const executorCommandCapacityKind = (operationKey: string): ExecutorCommandCapacityKind | null => {
  if (operationKey === 'command.run') return 'program'
  if (operationKey === 'coding.launch' || operationKey === 'coding.observe') return 'coding'
  if (operationKey.startsWith('browser.')) return 'browser'
  if (operationKey === 'mcp.tools' || operationKey === 'mcp.call') return 'mcp'
  if (operationKey.startsWith('file.') || operationKey.startsWith('workspace.')) return 'file'
  return null
}

const FreeSlotsSchema = z.number().int().min(0).max(EXECUTOR_CONCURRENT_COMMANDS_MAXIMUM)

/** Free slots per kind, as the daemon counts them when it signs the poll. */
export const ExecutorCommandCapacitySchema = z.object({
  file: FreeSlotsSchema,
  program: FreeSlotsSchema,
  coding: FreeSlotsSchema,
  browser: FreeSlotsSchema,
  mcp: FreeSlotsSchema,
}).strict()
export type ExecutorCommandCapacity = z.infer<typeof ExecutorCommandCapacitySchema>

/**
 * A command the daemon holds but is not running yet: `start` waits for a free
 * slot or for its resource (one terminal, one browser tab, one path), `owner`
 * waits for the computer's owner to answer a program request. A held command
 * the poll names in `activeCommands` but not here is running.
 */
export const ExecutorCommandWaitSchema = z.object({
  commandId: ExecutorCommandCancellationTargetSchema.shape.commandId,
  for: z.enum(['start', 'owner']),
}).strict()
export type ExecutorCommandWait = z.infer<typeof ExecutorCommandWaitSchema>

/**
 * Nessie ends a session: its run ended, the owner chose Stop, the lease
 * ended, or the team was paused or disconnected. The daemon ends the
 * session's resources (terminals, browsers, guest sandboxes, coding sessions
 * it started) and refuses its later commands. `reason` is for logs; known
 * values are `run_ended`, `owner_stopped`, `lease_ended`, `team_paused` and
 * `disconnected`, and a daemon treats an unknown one like any other.
 */
export const ExecutorSessionCloseSchema = z.object({
  sessionId: ExecutorSessionIdSchema,
  reason: z.string().regex(/^[a-z][a-z_]{0,63}$/u),
}).strict()
export type ExecutorSessionClose = z.infer<typeof ExecutorSessionCloseSchema>

/** The fields a concurrent daemon adds to its signed poll (all inside the signature). */
export const ExecutorConcurrentPollFieldsSchema = z.object({
  concurrency: z.literal(EXECUTOR_COMMAND_CONCURRENCY_VERSION),
  capacity: ExecutorCommandCapacitySchema,
  /** Every command the daemon holds without a result receipt yet: waiting, running or reporting. */
  activeCommands: z.array(ExecutorCommandCancellationTargetSchema).max(EXECUTOR_ACTIVE_COMMANDS_MAXIMUM),
  /** Present only when some held command is not running. */
  waiting: z.array(ExecutorCommandWaitSchema).min(1).max(EXECUTOR_ACTIVE_COMMANDS_MAXIMUM).optional(),
  /**
   * Sessions the owner stopped on the computer that Nessie has not closed
   * yet. The daemon names each one on every poll until a `sessionClose` for
   * it arrives; Nessie closes them with reason `owner_stopped`.
   */
  stoppedSessions: z.array(ExecutorSessionIdSchema).min(1).max(EXECUTOR_SESSION_CLOSE_MAXIMUM).optional(),
})

/** What Nessie answers a concurrent poll with, beside the commands themselves. */
export const ExecutorConcurrentPollAnswerFieldsSchema = z.object({
  /** One per active command Nessie wants cancelled; each names a command the poll listed. */
  cancellations: z.array(ExecutorCommandCancellationSchema).max(EXECUTOR_ACTIVE_COMMANDS_MAXIMUM),
  sessionClose: z.array(ExecutorSessionCloseSchema).max(EXECUTOR_SESSION_CLOSE_MAXIMUM),
})
