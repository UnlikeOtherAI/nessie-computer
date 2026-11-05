import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  agentFailureReason,
  AgentStartError,
  startAgentProcess,
  type AgentDriver,
  type AgentDriverContext,
  type AgentProcess,
} from './agent-process.js'
import { codexArguments, createCodexTurnState } from './codex-adapter.js'
import { CODING_EVENT_LIMITS } from './projection.js'
import { AGENT_SESSION_ID_PATTERN } from './types.js'

/**
 * The ChatGPT account Codex is logged in as, for redaction: `exec` never
 * prints it, but the model knows who it works for and can repeat it, as
 * Claude Code did. Read from the id token's claims in Codex's own
 * `auth.json`, held in memory only; no token is ever used or kept.
 */
export const codexAccountRedactions = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
  const home = env.CODEX_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.codex')
  try {
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as { tokens?: { id_token?: unknown } }
    const token = auth.tokens?.id_token
    if (typeof token !== 'string') return []
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    return [claims.email, claims.name].filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

type CodexTurn = { agent: AgentProcess; interrupted: boolean; reason?: string; done: Promise<void> }

/**
 * Codex runs one `exec` process per turn. `thread.started` names the session,
 * which every later turn resumes. A message sent during a turn waits for it
 * to end and then starts the next one, joined with any other waiting message;
 * interrupt kills the turn's process tree, and the thread stays resumable from
 * its rollout.
 *
 * `starting` is set before the first await of a turn and cleared only once
 * `turn` holds its process, so between one turn's exit and the next turn's
 * spawn the driver never looks idle: a host deciding whether to leave, or a
 * message arriving in that instant, sees a turn under way and waits for it.
 */
export const createCodexDriver = (context: AgentDriverContext): AgentDriver => {
  let turn: CodexTurn | undefined
  let starting = false
  let closing = false
  const retired = new Set<AgentProcess>()
  const queue: string[] = []

  const startTurn = async (text: string): Promise<void> => {
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    if (closing) return
    const state = context.state()
    const threadId = state.agentSessionStarted === true ? state.agentSessionId : undefined
    const current = createCodexTurnState(context.projector)
    const agent = await startAgentProcess(context, [
      context.agent.command[0]!,
      ...codexArguments(context.agent, { folder: context.folder, ...(threadId ? { threadId } : {}) }),
    ], (line) => {
      const signals = current.accept(line)
      for (const event of signals.events) context.emit(event)
      if (signals.threadId && !context.state().agentSessionStarted) {
        // It becomes an argv entry of every later turn, so only an id of the documented shape is kept.
        if (AGENT_SESSION_ID_PATTERN.test(signals.threadId)) {
          context.update({ agentSessionId: signals.threadId, agentSessionStarted: true })
        } else {
          context.emit({ kind: 'system', subtype: 'agent_failed', reason: 'agent_session_id_invalid' })
        }
      }
      if (signals.test) context.update({ lastTest: signals.test })
    })
    if (closing) {
      // The session closed while this turn was starting; its prompt is never delivered.
      if (agent.confirmHostExecutionStopped) {
        if (!await agent.confirmHostExecutionStopped()) retired.add(agent)
      } else await context.control.killTree(agent.identity)
      return
    }
    context.emit({ kind: 'user', text: context.projector.text(text, CODING_EVENT_LIMITS.user) })
    context.update({
      status: 'working', reason: undefined, turn: state.turn + 1, turnStartedAt: new Date().toISOString(),
      agentIdentity: agent.identity,
    })
    agent.write(text)
    agent.endInput()
    const entry: CodexTurn = { agent, interrupted: false, done: Promise.resolve() }
    entry.done = agent.exited.then(async ({ code }) => {
      const stopped = await agent.confirmHostExecutionStopped?.()
      if (stopped === false) retired.add(agent)
      turn = undefined
      const result = current.finish({ code, interrupted: entry.interrupted })
      context.emit({ kind: 'result', ...result })
      const failure = result.subtype === 'agent_exited' ? agentFailureReason(agent.stderrTail()) : undefined
      context.update({
        status: closing ? 'closed' : entry.interrupted ? 'interrupted' : 'waiting_for_input',
        reason: entry.interrupted ? entry.reason : failure,
        lastResult: result, ...(stopped !== false ? { agentIdentity: undefined } : {}), turnStartedAt: undefined,
      })
      if (closing || queue.length === 0) return
      const next = queue.splice(0).join('\n\n')
      context.update({ queued: 0 })
      void runTurn(next).catch((error: unknown) => {
        const reason = error instanceof AgentStartError ? error.reason : 'agent_exited'
        // A host that lost its lock writes nothing more; its heartbeat is about to exit it.
        if (reason !== 'host_superseded') context.update({ status: 'interrupted', reason })
      })
    })
    turn = entry
  }

  const runTurn = async (text: string): Promise<void> => {
    starting = true
    try {
      await startTurn(text)
    } finally {
      starting = false
    }
  }

  const killTurn = async (reason?: string): Promise<void> => {
    const current = turn
    if (!current) return
    current.interrupted = true
    current.reason = reason
    if (current.agent.confirmHostExecutionStopped) await current.agent.confirmHostExecutionStopped()
    else await context.control.killTree(current.agent.identity)
    await current.done
  }

  return {
    send: async (text) => {
      if (turn || starting) {
        queue.push(text)
        context.update({ queued: queue.length })
        return
      }
      await runTurn(text)
    },
    interrupt: (reason) => killTurn(reason),
    close: async (reason) => {
      closing = true
      queue.length = 0
      // The turn's end is what records the close, so it carries the reason.
      await killTurn(reason)
      for (const agent of retired) {
        if (await agent.confirmHostExecutionStopped?.()) retired.delete(agent)
      }
      const leftover = context.state().agentIdentity
      if (leftover) await context.control.killTree(leftover)
      context.update({ status: 'closed', reason, queued: 0,
        ...(retired.size === 0 ? { agentIdentity: undefined } : {}), turnStartedAt: undefined })
    },
    // Nothing outlives a turn here, so ending the agent is ending its turn; the thread stays resumable.
    endIdle: () => killTurn(),
    running: () => turn !== undefined || starting,
    busy: () => turn !== undefined || starting || queue.length > 0,
  }
}
