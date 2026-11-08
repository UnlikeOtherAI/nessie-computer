import {
  EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM,
  ExecutorMcpCallArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { codingSessionsPolicyOf } from './coding-sessions-policy.js'
import { localCommandPolicyOf, localCommandPolicyPermits, localTerminalCommandDecision } from './command-policy.js'
import { lendAnyProgram, lendRule, type CommandRulesLoan, type DaemonLiveState } from './daemon-live-state.js'
import { programRequestRefusal, programRequestRule, type ProgramRequestGate } from './program-request-gate.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * Where the dispatch turns a launch the rules refuse only as "not allowed"
 * into a program request (`program-request-gate.ts`), for the two kinds of
 * launch the rules govern: a sandboxed `command.run`, and a terminal session
 * the coding-sessions bridge starts on this computer (`session_start` with
 * `agent: "terminal"`). Only two refusals are asked about: `not_allowlisted`,
 * and for a terminal `path_needs_allow_all` (a program named by its path while
 * only listed programs may start). The denylist, or any other refusal, is
 * answered exactly as before and nobody is asked.
 *
 * An allowed launch runs inside `run`, which lends the rules it needs for that
 * launch alone (`DaemonLiveState.allowOnce`), so every later check of it — the
 * session manager's for a command, the bridge's for a terminal — permits it.
 */
export type ProgramAdmission = {
  gate: ProgramRequestGate
  allowOnce: DaemonLiveState['allowOnce']
}

export type Admitted = { refusal: Record<string, unknown> } | { run: <T>(work: () => Promise<T>) => Promise<T> }

const unchanged: Admitted = { run: (work) => work() }
const DENIED = { code: 'EXECUTOR_COMMAND_DENIED', success: false }

const ask = async (
  admission: ProgramAdmission, state: ExecutorLocalState, command: ExecutorCommandEnvelope,
  program: string, args: string[], signal: AbortSignal | undefined, loan?: CommandRulesLoan,
): Promise<Admitted | null> => {
  const rule = programRequestRule(program)
  // A full allowlist has no room for the rule "always" would add.
  if (!rule || localCommandPolicyOf(state).allowlist.length >= EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM) return null
  const verdict = await admission.gate.ask({ program, args, expiresAt: command.expiresAt, signal })
  if (!verdict.allowed) return { refusal: programRequestRefusal(program, verdict) }
  return { run: (work) => admission.allowOnce(loan ?? lendRule(rule), work) }
}

/** A `command.run` the rules refuse: asked about only when allowing every program would permit it. */
export const admitCommandRun = async (
  admission: ProgramAdmission | undefined, state: ExecutorLocalState, command: ExecutorCommandEnvelope,
  program: string, args: string[],
  /** Another refusal the launch would meet after an answer; it is returned instead of asking. */
  blocked: () => Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<Admitted> => {
  if (localCommandPolicyPermits(state, program, args)) return unchanged
  if (!admission) return { refusal: DENIED }
  const rules = localCommandPolicyOf(state)
  // The one shared predicate, asked again with every program allowed: what it
  // still refuses, the denylist or the argument checks refuse, and stays refused.
  if (!localCommandPolicyPermits({ ...state, commandPolicy: { ...rules, mode: 'all' } }, program, args)) {
    return { refusal: DENIED }
  }
  const refusal = blocked()
  if (refusal) return { refusal }
  return await ask(admission, state, command, program, args, signal) ?? { refusal: DENIED }
}

/**
 * An `mcp.call` that starts a terminal session the rules refuse as not
 * allowlisted, or as a path while only listed programs may start. Every other
 * call — and every other refusal, which the bridge gives itself — passes
 * through unchanged. A path launch is lent "any program not denied" for its
 * own length: no rule can name a path, and the daemon's one command lane keeps
 * the loan to this launch.
 */
export const admitTerminalLaunch = async (
  admission: ProgramAdmission | undefined, state: ExecutorLocalState, command: ExecutorCommandEnvelope,
  signal?: AbortSignal,
): Promise<Admitted> => {
  if (!admission) return unchanged
  const call = ExecutorMcpCallArgumentsSchema.safeParse(command.payload.args)
  const bridge = codingSessionsPolicyOf(state.descriptor.codingSessions, state.mcpServers)?.server.name
  if (!call.success || call.data.server !== bridge || call.data.tool !== 'session_start') return unchanged
  const launch = call.data.arguments as { agent?: unknown; command?: unknown } | undefined
  const argv = launch?.agent === 'terminal' && Array.isArray(launch.command) ? launch.command : undefined
  if (!argv?.every((entry): entry is string => typeof entry === 'string')) return unchanged
  const [program, ...args] = argv
  if (!program) return unchanged
  // The bridge's own decision, signature check included: an app UnlikeOtherAI signed needs no question.
  const decision = await localTerminalCommandDecision(localCommandPolicyOf(state), argv)
  if (decision.allowed) return unchanged
  if (decision.refusal === 'not_allowlisted') return await ask(admission, state, command, program, args, signal) ?? unchanged
  if (decision.refusal !== 'path_needs_allow_all') return unchanged
  return await ask(admission, state, command, program, args, signal, lendAnyProgram) ?? unchanged
}
