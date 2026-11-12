import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * Claude Code and Codex, installed and signed in on the computer, offered to
 * Nessie as engines (contract §12; docs/local-cli-engines.md). Each engine
 * connection is a local-inference host of role `local_cli`; after
 * registration it speaks the unchanged local-inference host protocol.
 */
export const LocalCliEngineSchema = z.enum(['claude-code', 'codex'])
export type LocalCliEngine = z.infer<typeof LocalCliEngineSchema>

/** Whether the CLI behind an advertised engine can answer a turn right now. */
export const LocalCliEngineStateSchema = z.enum(['ready', 'signed_out'])
export type LocalCliEngineState = z.infer<typeof LocalCliEngineStateSchema>

/** The machine-key signature domain of the registration route. */
export const LOCAL_CLI_HOST_SIGNATURE_DOMAIN = 'local_inference.cli_host'

/** Why an engine connection is withdrawn: the owner switched it off, or its CLI signed out or went away. */
export const LocalCliWithdrawReasonSchema = z.enum(['switched_off', 'signed_out', 'not_installed'])
export type LocalCliWithdrawReason = z.infer<typeof LocalCliWithdrawReasonSchema>

/** Body of `POST /api/local-inference/daemon/executor-cli-host`. */
export const LocalCliHostRequestSchema = z.object({
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
  executorId: z.string().uuid(),
  observedAt: TimestampSchema,
  engine: LocalCliEngineSchema,
  /** `null` is the CLI's own default account; a UUID names an account added in Nessie Computer. */
  profileId: z.string().uuid().nullable(),
  available: z.boolean(),
  /** Present exactly when `available` is false. */
  reason: LocalCliWithdrawReasonSchema.optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).min(64).max(128),
}).strict().refine((body) => (body.reason === undefined) === body.available,
  'A withdrawal names its reason; an offer has none.')
export type LocalCliHostRequest = z.infer<typeof LocalCliHostRequestSchema>

/** `available: true` answers the host; `available: false` answers its withdrawal. */
export const LocalCliHostResponseSchema = z.union([
  z.object({
    connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
    hostId: z.string().uuid(),
    organizationId: z.string().uuid(),
  }).strict(),
  z.object({ withdrawn: z.literal(true) }).strict(),
])
export type LocalCliHostResponse = z.infer<typeof LocalCliHostResponseSchema>

/** The one model name a CLI host advertises; an added account carries its profile. */
export const localCliModelName = (engine: LocalCliEngine, profileId: string | null): string =>
  profileId === null ? `cli:${engine}` : `cli:${engine}:${profileId}`

/** Error codes a CLI host puts in its error frame and receipt. */
export const LOCAL_CLI_ERROR_CODES = [
  'cli_signed_out', 'cli_not_installed', 'cli_unsupported', 'unsupported_capability',
  'session_stopped', 'cancelled', 'inference_incomplete', 'model_changed',
] as const
export type LocalCliErrorCode = (typeof LOCAL_CLI_ERROR_CODES)[number]

/** One row of `ai local list --json` and the `executor_local_ai` bridge answer. */
export const LocalCliEngineRowSchema = z.object({
  engine: LocalCliEngineSchema,
  profileId: z.string().uuid().nullable(),
  /** The owner's name for an added account; `null` for the default account. */
  name: z.string().min(1).max(80).nullable(),
  installed: z.boolean(),
  signedIn: z.boolean(),
  account: z.string().min(1).max(254).optional(),
  /** The team's Make available switch: on unless the owner switched it off. */
  available: z.boolean(),
  /**
   * `yes`: Nessie has the host; `no`: not offered (switched off, not installed or signed out);
   * `not_yet`: on and signed in, but Nessie doesn't offer it yet.
   */
  offered: z.enum(['yes', 'no', 'not_yet']),
}).strict()
export type LocalCliEngineRow = z.infer<typeof LocalCliEngineRowSchema>
