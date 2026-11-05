import { z } from 'zod'

import { AgentIdSchema, UserIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * The executor's built-in `coding-sessions` bridge: a local MCP server that
 * runs Claude Code or Codex on the host as long-lived sessions an agent
 * instructs. Unlike every other named server it is not a program somebody
 * named — the executor generates its launch spec itself — and it acts with the
 * host OS user's full authority, so what it may do travels in the signed
 * descriptor, who is calling travels with every call, and what it is doing
 * travels on the heartbeat. The contract is
 * `docs/executor-protocol/host-coding-sessions.md`.
 */

/** Reserved: the executor refuses a hand-named server of this name. */
export const EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME = 'coding-sessions'

/** OS-account sessions belong to the pairing owner, rather than an agent/run owner hash. */
export const EXISTING_CODING_SESSION_OWNER_KEY = `sha256:${'0'.repeat(64)}`

export const EXECUTOR_CODING_AGENT_NAMES = ['claude', 'codex', 'terminal'] as const
export const ExecutorCodingAgentNameSchema = z.enum(EXECUTOR_CODING_AGENT_NAMES)
export type ExecutorCodingAgentName = z.infer<typeof ExecutorCodingAgentNameSchema>

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** A root's name: the workspace-folder grammar, which the executor enforces in full. */
export const CodingRootNameSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(40)

/** A categorical reason, never free text: `lease_ended`, `host_lost`, `agent_missing`, … */
const CodingReasonSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length

/**
 * The commands a ticket needs to reach a merge on its own: push the branch,
 * open the pull request, watch its checks and merge it. The descriptor names
 * which of them Claude Code may run without being asked (`mergeCommands`), so
 * a standing policy's confirmation card can say whether a ticket on this
 * machine stops at an open pull request — without the host's tool list ever
 * leaving the host.
 */
export const EXECUTOR_CODING_MERGE_COMMANDS = ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'] as const
export const ExecutorCodingMergeCommandSchema = z.enum(EXECUTOR_CODING_MERGE_COMMANDS)
export type ExecutorCodingMergeCommand = z.infer<typeof ExecutorCodingMergeCommandSchema>

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => (
  [...left].sort().join(',') === [...right].sort().join(',')
)

/* -------------------------------------------------------------------------- */
/* The reviewed power facts                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the bridge may do, stated in the signed descriptor and so inside
 * `localPolicyDigest`: which coding agents, in which standing permission mode,
 * with how many pre-allowed tools, in which named folders. `configDigest`
 * covers the whole host-local configuration those facts summarise, and the
 * bridge refuses to start an agent while the file on disk hashes to anything
 * else — editing it changes nothing until a person reviews the new revision.
 *
 * Present exactly when the executor offers the bridge. Folder paths, agent
 * programs and their arguments stay on the host, as a named server's launch
 * spec always has.
 */
export const ExecutorCodingSessionsFactsSchema = z
  .object({
    serverName: z.literal(EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME),
    existingSessions: z.literal(true).optional(),
    agents: z.array(ExecutorCodingAgentNameSchema).max(EXECUTOR_CODING_AGENT_NAMES.length)
      .refine(distinct, 'Each coding agent is named once.'),
    /**
     * Per offered agent: Claude Code's `--permission-mode` (`default` when the
     * configuration sets none), or for Codex the approval and sandbox stance
     * its reviewed arguments choose.
     */
    permissionMode: z.record(ExecutorCodingAgentNameSchema, z.string().regex(/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/)),
    /** Claude Code's `allowedTools` entries — commands it may run without being asked. */
    allowedToolCount: z.number().int().min(0).max(128),
    /**
     * The environment variables the configuration sets or passes to the agents
     * (`agentEnv.set` and `agentEnv.pass`), by name and sorted: a
     * `CLAUDE_CONFIG_DIR` or an `ANTHROPIC_BASE_URL` changes what an agent may
     * do, or where its transcript goes, as surely as a flag does. Values stay on
     * the host.
     */
    environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(128)
      .refine(distinct, 'Each environment variable is named once.'),
    rootNames: z.array(CodingRootNameSchema).max(16).refine(distinct, 'Each coding root is named once.'),
    configDigest: Sha256DigestSchema,
    /**
     * Per offered agent: the most one turn may spend, in US dollars, or `null`
     * when nothing bounds it. Claude Code's is the configuration's
     * `maxBudgetUsd` (`--max-budget-usd`, with a fresh process whenever a turn
     * would start with less than the whole budget); Codex has no such flag, so
     * its turns are never bounded and it is always `null`.
     *
     * This and `maxLiveSessionsPerOwner` are absent from a descriptor an older
     * daemon signed, which is a machine that has not said — never one without
     * a limit. A check that needs them refuses such a machine.
     */
    maxBudgetUsd: z.record(ExecutorCodingAgentNameSchema, z.number().positive().max(1_000).nullable()).optional(),
    /**
     * How many live sessions one owner may hold on the machine at once; an
     * owner is an agent and a person, and one ticket's work is an owner of its
     * own (`executorCodingSessionOwnerKeyInput`).
     */
    maxLiveSessionsPerOwner: z.number().int().min(1).max(20).optional(),
    /**
     * Which of `EXECUTOR_CODING_MERGE_COMMANDS` Claude Code may run without
     * being asked: all of them under `bypassPermissions`, otherwise those an
     * `allowedTools` entry covers (`Bash`, `Bash(git *)`, `Bash(gh pr:*)`, …)
     * and no `disallowedTools` entry does. Empty when Claude Code is not
     * offered, since a Codex turn has no budget and so never works a ticket.
     * Absent from a descriptor an older daemon signed: a machine that has not
     * said, which a merge check reads as unable to merge.
     */
    mergeCommands: z.array(ExecutorCodingMergeCommandSchema).max(EXECUTOR_CODING_MERGE_COMMANDS.length)
      .refine(distinct, 'Each merge command is named once.').optional(),
    /**
     * Whether Claude Code may run any command at all without asking: `any`
     * under `bypassPermissions`, or when an `allowedTools` entry covers every
     * command (a bare `Bash`, `Bash(*)`, `Bash(:*)`) and no `disallowedTools`
     * entry takes that back; otherwise `listed`. Standing machine access needs
     * its author's separate "run any command" tick for `any`. Absent from an
     * older daemon's descriptor: a machine that has not said, which standing
     * machine access refuses as too old.
     */
    unaskedCommands: z.enum(['any', 'listed']).optional(),
    /**
     * `commandRules`: a `terminal` session starts the program the agent names
     * when it starts one — any program while the computer allows all
     * commands, otherwise one its allowlist names, and never one its denylist
     * names. The rules themselves stay on the machine. Absent from an older
     * daemon's descriptor, whose terminal ran one program configured locally;
     * the terminal tools are offered only when this is present.
     */
    terminalCommands: z.literal('commandRules').optional(),
  })
  .strict()
  .refine((facts) => facts.existingSessions || (facts.agents.length > 0 && facts.rootNames.length > 0),
    'Managed coding sessions need an agent and a root.')
  .refine((facts) => facts.terminalCommands === undefined || facts.agents.includes('terminal'),
    'Terminal commands are stated only when terminal sessions are offered.')
  .refine(
    (facts) => sameMembers(Object.keys(facts.permissionMode), facts.agents),
    'Every offered coding agent states its permission mode, and only those do.',
  )
  .refine(
    (facts) => facts.maxBudgetUsd === undefined || sameMembers(Object.keys(facts.maxBudgetUsd), facts.agents),
    'Every offered coding agent states its turn budget, and only those do.',
  )
export type ExecutorCodingSessionsFacts = z.infer<typeof ExecutorCodingSessionsFactsSchema>

/* -------------------------------------------------------------------------- */
/* Owners                                                                      */
/* -------------------------------------------------------------------------- */

const LowercaseUuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * The work an owner's sessions belong to, beside the agent and the person:
 * `ticket:<policyId>:<taskId>` for one ticket's work under a standing policy.
 * Absent for a launch and a conversation lease, whose sessions are the
 * person's own with that agent. It is hashed into the owner key, so a ticket's
 * sessions are isolated from the person's own and from every other ticket's,
 * and each has its own live-session quota. Lowercase ids only: the key hashes
 * the text, and one id spelled two ways would be two owners.
 */
export const ExecutorCodingSessionOwnerContextSchema = z
  .string()
  .regex(new RegExp(`^ticket:${LowercaseUuidPattern}:${LowercaseUuidPattern}$`))

/**
 * Who an `mcp.call` acts for, stamped by the worker from the binding's
 * candidate — never taken from the model. It rides the command payload beside
 * `runId`, outside the model's `arguments`, so the argument digest covers it
 * and no tool call can name somebody else.
 */
export const ExecutorMcpCallOwnerSchema = z
  .object({
    agentId: AgentIdSchema,
    actorUserId: UserIdSchema,
    contextId: ExecutorCodingSessionOwnerContextSchema.optional(),
  })
  .strict()
export type ExecutorMcpCallOwner = z.infer<typeof ExecutorMcpCallOwnerSchema>

/**
 * The owner key the bridge isolates sessions by: `sha256:` and the hex SHA-256
 * of this text. The daemon derives it for `_meta['nessie/owner']`; the control
 * plane derives the same key to name an owner in `codingSessionClose`. The
 * executor id is part of it, so one person's key on one machine means nothing
 * on another. A context is a fourth field; without one the text is the three
 * ids exactly as before it existed, so no session's key changed. None of the
 * ids can hold a vertical bar, so no three-field text equals a four-field one.
 * Hashing is each runtime's own; the text is this one function.
 */
export const executorCodingSessionOwnerKeyInput = (
  executorId: string,
  owner: { agentId: string; actorUserId: string; contextId?: string },
): string => [
  executorId, owner.agentId, owner.actorUserId, ...(owner.contextId === undefined ? [] : [owner.contextId]),
].join('|')

export const ExecutorCodingSessionOwnerKeySchema = Sha256DigestSchema

/* -------------------------------------------------------------------------- */
/* Teardown and the admin's view                                               */
/* -------------------------------------------------------------------------- */

/**
 * One instruction on a heartbeat response: close this owner's coding sessions
 * (or one of them) on this machine. The control plane sends it when a lease
 * ends, access is revoked, the executor is paused, or a person presses Close.
 */
export const ExecutorCodingSessionCloseSchema = z
  .object({
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    sessionId: z.string().uuid().optional(),
    reason: CodingReasonSchema,
  })
  .strict()
export type ExecutorCodingSessionClose = z.infer<typeof ExecutorCodingSessionCloseSchema>

/**
 * Why the control plane asks for a close — the vocabulary of the stored close
 * requests, which a CHECK pins. The wire field stays the open categorical
 * grammar above, so a daemon never refuses a reason it has not met yet.
 *
 * - `lease_ended`: the owner's last live conversation lease on the machine
 *   ended — its holder or a machine administrator pressed End, it expired,
 *   the executor drained, or a review dropped the local-apps pair;
 * - `access_revoked`: the agent's access to the machine, or the owner's place
 *   on its roster, was withdrawn;
 * - `executor_paused`, `executor_revoked`: the machine itself was fenced;
 * - `person`: a person pressed Close on one session.
 *
 * One ticket's work under a standing policy closes its own sessions, each
 * named by id (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md
 * → "Server-side closes"):
 *
 * - `ticket_left_flow`: the ticket entered one of the trigger's end columns;
 * - `trigger_changed`: the trigger was disabled, deleted, or edited in a
 *   pinned field;
 * - `policy_suspended`: the policy was suspended, its trigger or descriptor
 *   digest having changed;
 * - `policy_ended`: the policy ended — End, a fence, its author gone;
 * - `work_limit`: the work record hit one of its limits;
 * - `machine_reassigned`: the ticket's work left this machine for another —
 *   it stayed offline past the trigger's `waitingMachineHours`, or the work
 *   was placed elsewhere — so its sessions here close, when the machine next
 *   reports however long that takes (T5);
 * - `mover_lost_access`: queued work was cancelled because the person whose
 *   move started it can no longer edit the board (T5).
 */
export const EXECUTOR_CODING_SESSION_CLOSE_REASONS = [
  'lease_ended',
  'access_revoked',
  'executor_paused',
  'executor_revoked',
  'person',
  'ticket_left_flow',
  'goal_completed',
  'trigger_changed',
  'policy_suspended',
  'policy_ended',
  'work_limit',
  'machine_reassigned',
  'mover_lost_access',
] as const
export const ExecutorCodingSessionCloseReasonSchema = z.enum(EXECUTOR_CODING_SESSION_CLOSE_REASONS)
export type ExecutorCodingSessionCloseReason = z.infer<typeof ExecutorCodingSessionCloseReasonSchema>

export const EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM = 64

export const ExecutorCodingSessionCloseListSchema = z
  .array(ExecutorCodingSessionCloseSchema)
  .max(EXECUTOR_CODING_SESSION_CLOSE_MAXIMUM)

export const ExecutorCodingSessionStatusSchema = z.enum([
  'unknown',
  'starting',
  'working',
  'waiting_for_input',
  'interrupted',
  'failed',
  'closed',
])
export type ExecutorCodingSessionStatus = z.infer<typeof ExecutorCodingSessionStatusSchema>

/**
 * The statuses of a session that is running now. `unknown` is not one: it is
 * a saved native conversation whose live state the executor cannot see, and
 * counting it filled a machine's "running" with days-old Codex history.
 */
export const EXECUTOR_CODING_SESSION_OPEN_STATUSES: ReadonlySet<string> = new Set<ExecutorCodingSessionStatus>([
  'starting', 'working', 'waiting_for_input',
])

/**
 * One open session as the local-MCP report states it: enough for a person to
 * recognise it and close it, and nothing of what it said or did — no prompt,
 * no transcript, no path. The title is the task's first line as the bridge
 * recorded it, rewritten so no host path survives.
 *
 * `turn` counts the turns the coding agent has begun (0 before the first),
 * and `lastTurnEndedAt` is when the host last saw one end — its result, an
 * interrupt, the agent exiting, a close mid-turn — or `null` when none has.
 * A turn that began and ended between two reports still moves `turn`, which
 * is how a reader tells a fast turn from no change. Both are absent from an
 * older daemon's report, and absent infers nothing.
 */
export const ExecutorCodingSessionSummarySchema = z
  .object({
    sessionId: z.string().uuid(),
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    origin: z.literal('external').optional(),
    title: z.string().min(1).max(120),
    status: ExecutorCodingSessionStatusSchema,
    reason: CodingReasonSchema.optional(),
    agent: ExecutorCodingAgentNameSchema,
    root: CodingRootNameSchema,
    updatedAt: TimestampSchema,
    turn: z.number().int().min(0).optional(),
    lastTurnEndedAt: TimestampSchema.nullable().optional(),
    /**
     * What the session has cost across its turns, once a turn has reported a
     * cost — the same cumulative figure `session_status` answers. The heartbeat
     * intake adds what is new since its last report to a ticket's spend, so a
     * ticket's limits hold whether or not the model ever reads its status.
     * Absent from an older daemon's report, which infers nothing.
     */
    totalCostUsd: z.number().min(0).max(1_000_000).optional(),
  })
  .strict()
export type ExecutorCodingSessionSummary = z.infer<typeof ExecutorCodingSessionSummarySchema>

/**
 * A report lists open sessions before any other, so while they fit under this
 * cap it names every open one and an open session missing from it has ended.
 */
export const EXECUTOR_CODING_SESSION_REPORT_MAXIMUM = 32

/**
 * One open session as the executor page lists it, for the people who manage
 * the machine: what the local-MCP report said, plus two answers only the
 * control plane has. The agent driving it is named only when the reader could
 * see that agent themselves — the Agents tab's own rule — so `null` is a
 * boundary, not a gap. `closing` says a close request for it is open: the
 * machine has been told, and its next report has not yet dropped the session.
 */
export const ExecutorCodingSessionRecordSchema = ExecutorCodingSessionSummarySchema
  .extend({
    closing: z.boolean(),
    ownerAgentName: z.string().min(1).nullable(),
    /**
     * A ticket's own session, started by its work under its trigger's standing
     * machine access (its owner key carries the ticket's context): whose
     * access it runs under, and the ticket — named only when the reader can
     * read its project. Absent for a launch's or a lease's session.
     */
    ticketWork: z
      .object({
        authorName: z.string().min(1).nullable(),
        ticket: z
          .object({ taskId: z.string().uuid(), projectId: z.string().uuid(), title: z.string().min(1) })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
export type ExecutorCodingSessionRecord = z.infer<typeof ExecutorCodingSessionRecordSchema>

export const ExecutorCodingSessionListResponseSchema = z
  .object({
    /**
     * Whether this reader may press Close: the person who paired the machine,
     * whom every session on it acts as, and nobody else who manages it.
     */
    canClose: z.boolean(),
    sessions: z.array(ExecutorCodingSessionRecordSchema).max(EXECUTOR_CODING_SESSION_REPORT_MAXIMUM),
  })
  .strict()
export type ExecutorCodingSessionListResponse = z.infer<typeof ExecutorCodingSessionListResponseSchema>

/** A person's Close on one session, named exactly as the list named it. */
export const ExecutorCodingSessionCloseBodySchema = z
  .object({
    ownerKey: ExecutorCodingSessionOwnerKeySchema,
    sessionId: z.string().uuid(),
  })
  .strict()
export type ExecutorCodingSessionCloseBody = z.infer<typeof ExecutorCodingSessionCloseBodySchema>

/**
 * Accepted, not done: the request rides the machine's next heartbeat as
 * `codingSessionClose`, and the list reads "Closing…" until a report no
 * longer carries the session.
 */
export const ExecutorCodingSessionCloseAcceptedSchema = z
  .object({
    closing: z.literal(true),
    sessionId: z.string().uuid(),
  })
  .strict()
export type ExecutorCodingSessionCloseAccepted = z.infer<typeof ExecutorCodingSessionCloseAcceptedSchema>
