import { randomUUID } from 'node:crypto'

import {
  agentFailureReason,
  AgentStartError,
  startAgentProcess,
  type AgentDriver,
  type AgentDriverContext,
  type AgentProcess,
} from './agent-process.js'
import {
  claudeArguments,
  claudeControlLine,
  claudeUnsupportedLine,
  claudeUserLine,
  createClaudeStreamState,
  type ClaudeSignals,
  type ClaudeStreamState,
} from './claude-adapter.js'
import { CLAUDE_NO_OWNER_MESSAGE, planClaudeRequest } from './claude-requests.js'
import { AGENT_SESSION_ID_PATTERN, type CodingSessionResult } from './types.js'

/**
 * One long-lived Claude Code process per live host.
 *
 * Ready is the `initialize` control response. A follow-up is a stdin user
 * line, which folds into a running turn at its next tool boundary; interrupt
 * is a control request; close is `end_session`, end of stdin, and the tree
 * kill five seconds later, with the descendants read before anything was
 * signalled so a tool that outlives Claude is still found.
 *
 * The CLI enforces `--max-budget-usd` against its per-process running total
 * (`total_cost_usd` accumulates across turns), so with a budget configured a
 * message that would start a new turn in a process that has already spent
 * something is sent to a fresh process resuming the same session: every turn
 * starts with the whole budget. A process with background tasks still running
 * is kept instead, because a restart would end them.
 */
const READY_TIMEOUT_MS = 60_000
const CLOSE_GRACE_MS = 5_000

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms).unref() })

export const createClaudeDriver = (context: AgentDriverContext): AgentDriver => {
  let agent: AgentProcess | undefined
  let stream: ClaudeStreamState | undefined
  let starting: Promise<AgentProcess> | undefined
  let interruptRequested = false
  let interruptReason: string | undefined
  let ending = false

  const beginTurn = (): void => {
    const state = context.state()
    if (state.status === 'working') return
    context.update({ status: 'working', reason: undefined, turn: state.turn + 1, turnStartedAt: new Date().toISOString() })
  }

  const finishTurn = (result: CodingSessionResult): void => {
    const state = context.state()
    context.update({
      status: interruptRequested ? 'interrupted' : 'waiting_for_input',
      reason: interruptRequested ? interruptReason : undefined,
      lastResult: result,
      permissionDenials: [...state.permissionDenials, ...result.permissionDenials].slice(-20),
      ...(result.costUsd === undefined ? {} : { totalCostUsd: (state.totalCostUsd ?? 0) + result.costUsd }),
      turnStartedAt: undefined,
    })
    interruptRequested = false
    interruptReason = undefined
  }

  const handle = (signals: ClaudeSignals, ready: { resolve: () => void; reject: (error: Error) => void }): void => {
    for (const event of signals.events) context.emit(event)
    if (signals.ready) ready.resolve()
    if (signals.initializeFailed) ready.reject(new AgentStartError('agent_exited'))
    // It becomes `--resume <id>` for every later process, so only an id of the documented shape is kept.
    const sessionId = signals.agentSessionId
    if (sessionId && !context.state().agentSessionStarted && AGENT_SESSION_ID_PATTERN.test(sessionId)) {
      context.update({ agentSessionId: sessionId, agentSessionStarted: true })
    }
    if (signals.active) beginTurn()
    if (signals.unsupportedControlRequest) agent?.write(claudeUnsupportedLine(signals.unsupportedControlRequest))
    if (signals.prompt) ask(signals.prompt)
    if (signals.cancelledControlRequest) {
      const id = asked.get(signals.cancelledControlRequest)
      if (id) context.requests.withdraw(id, 'cancelled', 'provider_cancelled')
    }
    if (signals.test) context.update({ lastTest: signals.test })
    if (signals.backgroundTasks !== undefined) context.update({ backgroundTasks: signals.backgroundTasks })
    if (signals.turnFinished) finishTurn(signals.turnFinished)
  }

  /** Claude's control request id → the owner's request id, while the prompt waits. */
  const asked = new Map<string, string>()

  /** A permission prompt or question: the owner's to answer, unless it is the session's own secret tool. */
  const ask = (prompt: NonNullable<ClaudeSignals['prompt']>): void => {
    const asker = agent
    const plan = planClaudeRequest(prompt, context.projector, context.folder, context.roots)
    if (plan.kind === 'allow') {
      asker?.write(plan.line)
      return
    }
    const opened = context.requests.open(plan.draft, {
      answer: (answer) => {
        asked.delete(prompt.requestId)
        const reply = plan.answer(answer)
        // A cancel stops the turn: Claude interrupts itself, and the turn ends as interrupted.
        if (reply.stopsTurn) interruptRequested = true
        if (asker?.alive()) asker.write(reply.line)
      },
      withdraw: (_status, reason) => {
        asked.delete(prompt.requestId)
        if (asker?.alive() && reason !== 'provider_cancelled') asker.write(plan.withdraw(reason))
      },
    })
    // A prompt the protocol cannot carry is turned down rather than left waiting on nobody.
    if (opened) asked.set(prompt.requestId, opened.id)
    else if (!context.requests.ownerReachable()) {
      // Nessie has not shown it can ask the owner: denied as every prompt was before it could.
      asker?.write(plan.answer({ requestId: '', decision: 'decline', feedback: CLAUDE_NO_OWNER_MESSAGE }).line)
    } else {
      context.log('a permission prompt could not be shown to the owner')
      asker?.write(plan.withdraw('unreadable_request'))
    }
  }

  const start = async (): Promise<AgentProcess> => {
    const state = context.state()
    const sessionId = state.agentSessionId ?? randomUUID()
    const resume = state.agentSessionId !== undefined && state.agentSessionStarted === true
    if (state.agentSessionId === undefined) context.update({ agentSessionId: sessionId })
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    const current = createClaudeStreamState(context.projector)
    stream = current
    let resolveReady = (): void => undefined
    let rejectReady = (_error: Error): void => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const readyHooks = { resolve: () => resolveReady(), reject: (error: Error) => rejectReady(error) }
    const spawned = await startAgentProcess(context, [
      context.agent.command[0]!,
      ...claudeArguments(context.agent, {
        sessionId, resume, ...(context.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: context.maxBudgetUsd }),
        ...(context.secretServer ? { mcpServer: context.secretServer } : {}),
      }),
    ], (line) => handle(current.accept(line), readyHooks))
    agent = spawned
    context.update({ agentIdentity: spawned.identity })
    void spawned.exited.then(({ code }) => {
      if (!spawned.confirmHostExecutionStopped && agent === spawned) agent = undefined
      const reason = agentFailureReason(spawned.stderrTail())
      rejectReady(new AgentStartError(reason))
      // Nothing is left to answer what this process asked.
      for (const id of asked.values()) context.requests.withdraw(id, 'expired', 'provider_exited')
      asked.clear()
      // An agent we are stopping, or one whose session is already closed, exited as asked.
      if (ending || context.state().status === 'closed') return
      context.log(`claude exited with code ${code}`)
      const busy = current.busy()
      context.update({ ...(!spawned.confirmHostExecutionStopped ? { agentIdentity: undefined } : {}),
        backgroundTasks: undefined })
      if (busy || context.state().status === 'working' || context.state().status === 'starting') {
        context.emit({ kind: 'system', subtype: 'agent_exited', reason })
        context.update({ status: 'interrupted', reason, turnStartedAt: undefined })
      }
    })
    spawned.write(claudeControlLine('initialize'))
    const timer = setTimeout(() => rejectReady(new AgentStartError('agent_exited')), READY_TIMEOUT_MS)
    try {
      await ready
    } finally {
      clearTimeout(timer)
    }
    return spawned
  }

  const ensureAgent = async (): Promise<AgentProcess> => {
    if (agent?.alive()) return agent
    starting ??= start().finally(() => { starting = undefined })
    return starting
  }

  const stop = async (): Promise<void> => {
    const current = agent
    const identity = current?.identity ?? context.state().agentIdentity
    if (!identity) return
    ending = true
    const snapshot = await context.control.descendants(identity)
    if (current?.alive()) {
      current.write(claudeControlLine('end_session'))
      current.endInput()
      await Promise.race([current.exited, delay(CLOSE_GRACE_MS)])
    }
    const stopped = current?.confirmHostExecutionStopped
      ? await current.confirmHostExecutionStopped(snapshot)
      : (await context.control.killTree(identity, snapshot), true)
    if (stopped) agent = undefined
    // An interrupt the ended process never answered belongs to it, not to the next turn.
    interruptRequested = false
    interruptReason = undefined
    // Its background tasks went with it.
    context.update({ ...(stopped ? { agentIdentity: undefined } : {}), backgroundTasks: undefined })
    ending = false
  }

  return {
    send: async (text, uuid) => {
      if (context.maxBudgetUsd !== undefined && agent?.alive() && stream && !stream.busy()
        && stream.processCostUsd() > 0 && stream.backgroundTasks() === 0) {
        context.log('starting a fresh claude process so the next turn has its whole budget')
        await stop()
      }
      const running = await ensureAgent()
      stream?.noteSent(uuid)
      beginTurn()
      running.write(claudeUserLine(uuid, text))
    },
    interrupt: async (reason) => {
      if (!agent?.alive() || !stream?.busy()) return
      interruptRequested = true
      interruptReason = reason
      agent.write(claudeControlLine('interrupt'))
    },
    close: async (reason) => {
      await stop()
      context.update({ status: 'closed', reason, turnStartedAt: undefined })
    },
    endIdle: stop,
    running: () => agent?.alive() === true || starting !== undefined,
    busy: () => starting !== undefined || agent?.alive() === true && stream?.busy() === true,
  }
}
