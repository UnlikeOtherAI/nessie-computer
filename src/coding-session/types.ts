import type { ExecutorSessionAnswer, PersonalInferenceAuthority } from '@nessie/executor-protocol'

/**
 * The shapes the coding-sessions bridge and its session hosts share on disk.
 *
 * Two writers never touch one file: the bridge writes `meta.json` once, at
 * `session_start`, and the requests in `inbox/`; the host alone writes
 * `session.json` and `events.jsonl`. Everything a reader derives — "host lost",
 * "starting" — is derived at read time rather than written back by the bridge.
 */

/**
 * Bumped whenever the bridge and host stop understanding each other's files.
 * A bridge that meets a host speaking an older version asks it to retire after
 * its current turn instead of driving it.
 */
export const CODING_SESSION_PROTOCOL_VERSION = 1

export const CODING_AGENT_NAMES = ['claude', 'codex', 'terminal'] as const
export type CodingAgentName = typeof CODING_AGENT_NAMES[number]

/**
 * The agents a configuration names. A `terminal` session is built in: it
 * starts the program the agent names, under the computer's command rules.
 */
export const STRUCTURED_CODING_AGENT_NAMES = ['claude', 'codex'] as const
export type StructuredCodingAgentName = typeof STRUCTURED_CODING_AGENT_NAMES[number]

export type CodingSessionStatus =
  | 'starting'
  | 'working'
  | 'waiting_for_input'
  | 'interrupted'
  | 'failed'
  | 'closed'

/** A session counts against its owner's quota until it is closed or failed. */
export const codingSessionIsLive = (status: CodingSessionStatus): boolean => (
  status !== 'closed' && status !== 'failed'
)

/** Written once by the bridge; the owner and the reach of a session never change. */
export type CodingSessionMeta = {
  personalAuthority?: PersonalInferenceAuthority
  version: 1
  sessionId: string
  ownerKey: string
  agent: CodingAgentName
  /** A terminal session's is `terminal`: it runs in `cwd`, which no root need contain. */
  rootName: string
  /** Root-relative and normalised; `.` is the root itself. */
  path: string
  title: string
  createdAt: string
  /** A terminal session's program and arguments, exactly as the command rules permitted them. */
  command?: string[]
  /** A terminal session's absolute working directory. */
  cwd?: string
}

export type CodingPermissionDenial = { tool: string; summary: string }

export type CodingSessionResult = {
  text: string
  isError: boolean
  subtype: string
  turns?: number
  /** This turn's cost: the CLI reports a per-process running total, so this is its delta. */
  costUsd?: number
  durationMs?: number
  permissionDenials: CodingPermissionDenial[]
  /** Set when the turn started without a message from us (a finished background task). */
  origin?: string
}

/**
 * A process the host started, identified well enough that a reused pid is
 * never signalled. `startedAt` is a decimal start time in the OS's own unit;
 * an identity without one is unknown, and nothing ever signals it.
 */
export type CodingProcessIdentity = { pid: number; startedAt?: string; containment?: 'windows_job' | 'posix_group' }

/** Host-written, debounced; never carries raw agent output. */
export type CodingSessionState = {
  version: 1
  status: CodingSessionStatus
  /** Categorical: `host_lost`, `agent_missing`, `agent_exited`, … never free text. */
  reason?: string
  updatedAt: string
  turn: number
  agentSessionId?: string
  /** True once the agent has written a transcript, so a new process resumes it. */
  agentSessionStarted?: boolean
  /**
   * Every message sent since the start, joined by blank lines, until the agent
   * confirms its session or answers a turn: an agent lost before then (its
   * host killed, or it exited, before its init) took them with it, so the next
   * send carries them again.
   */
  firstPrompt?: string
  agentVersion?: string
  agentIdentity?: CodingProcessIdentity
  baseCommit?: string
  branch?: string
  /** Canonical host paths of the worktrees that existed at start; never reported raw. */
  worktreesAtStart?: string[]
  turnStartedAt?: string
  /**
   * When the host last saw a turn end: the status leaving `working`, however
   * it did — a result, an interrupt, the agent exiting, a close mid-turn, a
   * host that found its predecessor had died mid-turn. Absent until one has.
   */
  lastTurnEndedAt?: string
  lastResult?: CodingSessionResult
  permissionDenials: CodingPermissionDenial[]
  totalCostUsd?: number
  lastTest?: { command: string; exitCode: number | null }
  eventsGeneration: number
  lastSeq: number
  /** Follow-ups waiting for the next turn (Codex runs one process per turn). */
  queued: number
  /** Background tasks the agent left running; they hold no turn open, and one finishing starts a turn of its own. */
  backgroundTasks?: number
  /** How a terminal session's program exited, once it has. */
  exitCode?: number
}

/**
 * What a session reports, per kind, after projection. Nothing else reaches
 * `events.jsonl`: the raw agent stream is parsed in memory and dropped.
 */
export type CodingEventBody =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'tool_result'; name?: string; summary: string; isError?: true; exitCode?: number }
  | ({ kind: 'result' } & CodingSessionResult)
  | {
    kind: 'system'
    subtype: string
    model?: string
    permissionMode?: string
    message?: string
    reason?: string
    status?: CodingSessionStatus
    tool?: string
  }

export type CodingSessionEvent = CodingEventBody & { seq: number; at: string }

/** A request the bridge leaves for the host, named after the executor command that caused it. */
export type CodingSessionRequest = {
  id: string
  kind: 'start' | 'send' | 'interrupt' | 'close' | 'retire' | 'answer'
  text?: string
  reason?: string
  /** `answer`: the owner's answer, a secret's value replaced by the fact that it was saved. */
  answer?: Omit<ExecutorSessionAnswer, 'secret'> & { secretSaved?: true }
  at: string
}

/** The agent CLIs' own session and thread ids, which later become argv: a UUID, never anything read as a flag. */
export const AGENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export const CODING_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export const initialCodingSessionState = (now: string): CodingSessionState => ({
  version: 1,
  status: 'starting',
  updatedAt: now,
  turn: 0,
  permissionDenials: [],
  eventsGeneration: 0,
  lastSeq: 0,
  queued: 0,
})
