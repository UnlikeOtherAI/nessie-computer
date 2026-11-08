import {
  EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM,
  ExecutorMcpCallArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { codingSessionsPolicyOf } from './coding-sessions-policy.js'
import {
  localCommandPolicyOf, localCommandPolicyPermits, localTerminalCommandDecision, type LocalCommandPolicy,
} from './command-policy.js'
import type { OwnerWait } from './command-dispatcher.js'
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
 * An allowed launch is admitted with the rules it runs under — the saved
 * rules plus its own `<program> *`, or for a program named by its path every
 * program not denied — and those rules travel with that one launch only: the
 * session manager checks the command against them, and the bridge receives
 * them stamped on that one call. Nothing else running on the computer, and no
 * later launch, sees them.
 *
 * While the owner is asked, `ownerWait` hands the command's slot back, so
 * only the asking command waits.
 */
export type ProgramAdmission = {
  gate: ProgramRequestGate
  ownerWait?: OwnerWait
}

/** `rules`: the rules this one launch runs under, when they differ from the saved ones. */
export type Admitted = { refusal: Record<string, unknown> } | { rules?: LocalCommandPolicy }

const unchanged: Admitted = {}
const DENIED = { code: 'EXECUTOR_COMMAND_DENIED', success: false }

/** One launch's rules: the saved ones with the program's rule. The denylist stays. */
export const withRule = (saved: LocalCommandPolicy, rule: string): LocalCommandPolicy => (
  saved.allowlist.includes(rule) ? saved : { ...saved, allowlist: [...saved.allowlist, rule].sort() }
)

/** One launch's rules for a program named by its path, which no rule can name. The denylist stays. */
export const withAnyProgram = (saved: LocalCommandPolicy): LocalCommandPolicy => ({ ...saved, mode: 'all' })

const ask = async (
  admission: ProgramAdmission, state: ExecutorLocalState, command: ExecutorCommandEnvelope,
  program: string, args: string[], signal: AbortSignal | undefined, anyProgram = false,
): Promise<Admitted | null> => {
  const rule = programRequestRule(program)
  const saved = localCommandPolicyOf(state)
  // A full allowlist has no room for the rule "always" would add.
  if (!rule || saved.allowlist.length >= EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM) return null
  let asked = false
  const verdict = await admission.gate.ask({
    program, args, expiresAt: command.expiresAt, signal,
    origin: {
      commandId: command.commandId,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(command.agentName ? { agentName: command.agentName } : {}),
    },
    onAsked: (id) => {
      asked = true
      admission.ownerWait?.begin(id)
    },
  })
  // An allowed launch waits for a slot again before it runs; a refused one only reports.
  if (asked) await admission.ownerWait?.end(verdict.allowed)
  signal?.throwIfAborted()
  if (!verdict.allowed) return { refusal: programRequestRefusal(program, verdict) }
  return { rules: anyProgram ? withAnyProgram(saved) : withRule(saved, rule) }
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
 * through unchanged.
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
  return await ask(admission, state, command, program, args, signal, true) ?? unchanged
}
