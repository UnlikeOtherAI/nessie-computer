import { SessionEffectRefused, type SessionEffectAuthority } from './session-effect-authority.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  agentFailureReason,
  AgentStartError,
  AgentProcessStopUnproved,
  startAgentProcess,
  type AgentDriver,
  type AgentDriverContext,
  type AgentProcess,
} from './agent-process.js'
import { CodexAppConnection, type CodexServerRequest } from './codex-app-connection.js'
import { codexAppServerArguments, codexPolicy, createCodexTurnState, type CodexSignals } from './codex-adapter.js'
import { planCodexRequest } from './codex-requests.js'
import { CODING_EVENT_LIMITS } from './projection.js'
import type { FileChange } from './request-drafts.js'
import { AGENT_SESSION_ID_PATTERN } from './types.js'

/**
 * The ChatGPT account Codex is logged in as, for redaction: the model knows
 * who it works for and can repeat it, as Claude Code did. Read from the id
 * token's claims in Codex's own `auth.json`, held in memory only; no token is
 * ever used or kept.
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

/** Told to Codex beside its own instructions: who drives, and how to ask for a secret. */
export const CODEX_DEVELOPER_INSTRUCTIONS = [
  'A Nessie agent drives this session on behalf of the machine\'s owner, who is not at this terminal.',
  'The owner answers approvals and questions from Nessie, sometimes after a while, and may decline them.',
  'When you need a secret such as an API key or a token, call the request_secret tool, which saves it to a file',
  'you name; never ask for one in chat.',
].join(' ')

const CLOSE_GRACE_MS = 2_000
/** How long a secret request may wait on its owner before Codex gives up on the tool call. */
const SECRET_TOOL_TIMEOUT_SEC = 24 * 60 * 60

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms).unref() })

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

/**
 * One `codex app-server` per live host, holding the session's thread: the
 * first message starts it (`thread/start`), and a later process resumes it
 * (`thread/resume`). Each message is a `turn/start`; one sent while a turn
 * runs waits for that turn to end and starts its own next turn with its original
 * authority. Interrupt is `turn/interrupt`; Codex's own requests wait
 * for the owner (`codex-requests.ts`). Ending the process ends nothing the
 * thread remembers, so a session idle long enough loses only its process.
 */
export const createCodexDriver = (context: AgentDriverContext): AgentDriver => {
  const policy = codexPolicy(context.agent.args)
  const turn = createCodexTurnState(context.projector)
  let agent: AgentProcess | undefined
  let rpc: CodexAppConnection | undefined
  let threadId: string | undefined
  let starting: Promise<void> | undefined
  let turnActive = false
  let turnBeginning = false
  let turnId: string | undefined
  let interrupt: { reason?: string; sent: boolean; effect?: SessionEffectAuthority } | undefined
  let closing = false
  let ending = false
  let stopDebt: AgentProcessStopUnproved | undefined
  const replyFailed = (): void => {
    context.update({ status: 'interrupted', reason: 'provider_reply_unknown' })
    void stop().catch(() => context.log('Provider stop clearance remains unknown.'))
  }
  const queue: { text: string; effect?: SessionEffectAuthority }[] = []
  const fileChanges = new Map<string, FileChange[]>()
  /** Codex's request id → the owner's request id, while it waits. */
  const asked = new Map<string | number, string>()

  const sendInterrupt = async (): Promise<void> => {
    if (!interrupt || interrupt.sent || !rpc || !threadId || !turnId) return
    const pending = interrupt
    await pending.effect?.consume()
    pending.effect?.assertLive()
    if (interrupt !== pending || !rpc || !threadId || !turnId) return
    interrupt.sent = true
    await rpc.request('turn/interrupt', { threadId, turnId }, pending.effect)
  }

  const withdrawAsked = async (status: 'cancelled' | 'expired', reason: string): Promise<void> => {
    for (const id of [...asked.values()]) await context.requests.withdraw(id, status, reason)
    asked.clear()
  }

  const finishTurn = async (ended: NonNullable<CodexSignals['turnEnded']>): Promise<void> => {
    const { status, ...result } = ended
    // Whatever Codex still asked belongs to the turn that just ended.
    await withdrawAsked('expired', 'turn_ended')
    turnActive = false
    turnId = undefined
    context.emit({ kind: 'result', ...result })
    const interrupted = status === 'interrupted' || interrupt !== undefined
    context.update({
      status: closing ? 'closed' : interrupted ? 'interrupted' : 'waiting_for_input',
      reason: interrupted ? interrupt?.reason : undefined, lastResult: result, turnStartedAt: undefined,
    })
    interrupt = undefined
    if (closing || queue.length === 0) return
    void drainQueue()
  }

  const drainQueue = async (): Promise<void> => {
    while (!closing && !turnActive && !turnBeginning && queue.length) {
      const next = queue.shift()!
      context.update({ queued: queue.length })
      try { await runTurn(next.text, next.effect) }
      catch (error) {
        const reason = error instanceof SessionEffectRefused ? 'session_authority_unavailable'
          : error instanceof AgentStartError ? error.reason : 'agent_exited'
        context.update({ status: 'interrupted', reason })
        // The bridge's immutable request intent remains available for reconciliation.
      }
    }
  }

  const serve = async (request: CodexServerRequest): Promise<void> => {
    const connection = rpc
    if (!connection) return
    const plan = planCodexRequest(request, {
      projector: context.projector, folder: context.folder, roots: context.roots,
      fileChanges: (itemId) => fileChanges.get(itemId) ?? [],
    })
    if (plan.kind === 'reply') { await connection.respond(request.id, plan.result); return }
    if (plan.kind === 'unsupported') return connection.respondError(request.id, 'This client does not serve that request.')
    const opened = context.requests.open(plan.draft, {
      answer: async (answer, effect) => {
        effect?.assertLive()
        asked.delete(request.id)
        const reply = plan.answer(answer)
        await connection.respond(request.id, reply.result, effect)
        // Feedback with a decline reaches the running turn, so the agent can change course.
        if (reply.feedback && threadId && turnId) {
          await connection.request('turn/steer', { threadId, expectedTurnId: turnId,
            input: [{ type: 'text', text: reply.feedback, text_elements: [] }] }, effect)
        }
        if (reply.stopsTurn) {
          interrupt ??= { sent: false, effect }
          void sendInterrupt().catch(() => context.log('Original interrupt intent requires reconciliation.'))
        }
      },
      withdraw: async (_status, reason) => {
        asked.delete(request.id)
        if (reason !== 'provider_cancelled' && agent?.alive()) await connection.respond(request.id, plan.withdraw())
      },
    })
    // A request the protocol cannot carry is turned down rather than left waiting on nobody.
    if (opened) asked.set(request.id, opened.id)
    else if (!context.requests.ownerReachable()) {
      // Nessie has not shown it can ask the owner: declined, and the turn goes on, as under `exec`.
      await connection.respond(request.id, plan.answer({ requestId: '', decision: 'decline' }).result)
    } else {
      context.log('a Codex request could not be shown to the owner')
      await connection.respond(request.id, plan.withdraw())
    }
  }

  const accept = async (line: string): Promise<void> => {
    const { notification, request } = rpc?.accept(line) ?? {}
    if (request) await serve(request)
    if (!notification) return
    const item = notification.params.item
    const started = notification.method === 'item/started' && record(item) && item.type === 'fileChange'
    if (started && typeof item.id === 'string') {
      const changes = Array.isArray(item.changes) ? item.changes : []
      // Every change, even past what a request can list, so a request knows when it could not show them all.
      fileChanges.set(item.id, changes.filter(record).map((change) => ({
        path: typeof change.path === 'string' ? change.path : '',
        change: record(change.kind) && (change.kind.type === 'add' || change.kind.type === 'delete') ? change.kind.type
          : record(change.kind) && typeof change.kind.move_path === 'string' ? 'move' : 'update',
        ...(typeof change.diff === 'string' ? { diff: change.diff } : {}),
      })))
      if (fileChanges.size > 64) fileChanges.delete(fileChanges.keys().next().value!)
    }
    const signals = turn.accept(notification)
    for (const event of signals.events) context.emit(event)
    if (signals.test) context.update({ lastTest: signals.test })
    if (signals.turnId && turnActive) {
      turnId = signals.turnId
      void sendInterrupt().catch(() => context.log('Original interrupt intent requires reconciliation.'))
    }
    if (signals.resolvedRequest !== undefined) {
      const id = asked.get(signals.resolvedRequest)
      if (id) await context.requests.withdraw(id, 'cancelled', 'provider_cancelled')
    }
    if (signals.turnEnded && turnActive) await finishTurn(signals.turnEnded)
  }

  const exited = async (spawned: AgentProcess, clearance: 'stopped' | 'unknown'): Promise<void> => {
    if (agent === spawned) {
      if (clearance === 'stopped') agent = undefined
      rpc?.failAll()
      rpc = undefined
    }
    await withdrawAsked('expired', 'provider_exited')
    if (ending || closing || context.state().status === 'closed') return
    context.update({ ...(clearance === 'stopped' ? { agentIdentity: undefined } : {}) })
    if (clearance === 'unknown' || turnActive || turnBeginning) {
      turnActive = false
      turnId = undefined
      const reason = clearance === 'unknown' ? 'provider_stop_unproved'
        : interrupt?.reason ?? agentFailureReason(spawned.stderrTail())
      interrupt = undefined
      context.emit({ kind: 'system', subtype: 'agent_exited', reason })
      context.update({ status: 'interrupted', reason, turnStartedAt: undefined })
    }
  }

  const start = async (effect?: SessionEffectAuthority): Promise<void> => {
    if ('unsupported' in policy) throw new AgentStartError('agent_args_unsupported')
    if (!await context.stillOwner()) throw new AgentStartError('host_superseded')
    const spawned = await startAgentProcess(context, [
      context.agent.command[0]!, ...codexAppServerArguments(context.agent),
    ], (line) => { void accept(line).catch(replyFailed) }, effect)
      .catch(error => {
        if (error instanceof AgentProcessStopUnproved) {
          stopDebt = error
          if (error.identity) context.update({ agentIdentity: error.identity })
        }
        throw error
      })
    agent = spawned
    rpc = new CodexAppConnection((line, authority) => spawned.write(line, authority), 60_000,
      line => spawned.writeProtocol(line))
    context.update({ agentIdentity: spawned.identity })
    void spawned.exited.then(({ clearance }) => exited(spawned, clearance)).catch(replyFailed)
    const connection = rpc
    try {
      await effect?.consume()
      effect?.assertLive()
      await connection.request('initialize', {
        clientInfo: { name: 'nessie_executor', version: '1.0.0' }, capabilities: { experimentalApi: true },
      }, effect)
      await effect?.consume()
      effect?.assertLive()
      await connection.notify('initialized', undefined, effect)
      const secret = context.secretServer
      const params = {
        cwd: context.folder, sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy,
        ...(policy.approvalsReviewer ? { approvalsReviewer: policy.approvalsReviewer } : {}),
        ...(context.agent.model === undefined ? {} : { model: context.agent.model }),
        developerInstructions: CODEX_DEVELOPER_INSTRUCTIONS,
        // Dotted keys add the session's server beside the owner's own, as `-c` would.
        ...(secret ? { config: {
          [`mcp_servers.${secret.name}.command`]: secret.command,
          [`mcp_servers.${secret.name}.args`]: secret.args,
          [`mcp_servers.${secret.name}.tool_timeout_sec`]: SECRET_TOOL_TIMEOUT_SEC,
        } } : {}),
      }
      const state = context.state()
      const resume = state.agentSessionStarted === true ? state.agentSessionId : undefined
      await effect?.consume()
      effect?.assertLive()
      const answer = await connection.request(resume ? 'thread/resume' : 'thread/start', {
        ...(resume ? { threadId: resume } : {}), ...params,
      }, effect)
      const thread = record(answer) && record(answer.thread) ? answer.thread : {}
      // It is resumed by id in every later process, so only an id of the documented shape is kept.
      if (typeof thread.id !== 'string' || !AGENT_SESSION_ID_PATTERN.test(thread.id)) {
        throw new AgentStartError('agent_session_id_invalid')
      }
      threadId = thread.id
      if (!state.agentSessionStarted) context.update({ agentSessionId: thread.id, agentSessionStarted: true })
    } catch (error) {
      await stop()
      if (error instanceof AgentStartError || error instanceof SessionEffectRefused) throw error
      throw new AgentStartError(resumeFailed(error) ? 'agent_resume_failed' : agentFailureReason(spawned.stderrTail()))
    }
  }

  const resumeFailed = (error: unknown): boolean => (
    !!error && typeof error === 'object' && (error as { method?: unknown }).method === 'thread/resume'
  )

  const ensureStarted = async (effect?: SessionEffectAuthority): Promise<void> => {
    if (stopDebt) throw stopDebt
    if (agent?.alive() && rpc && threadId) return
    if (agent || context.state().agentIdentity) await stop(effect)
    starting ??= start(effect).finally(() => { starting = undefined })
    await starting
  }

  const runTurn = async (text: string, effect?: SessionEffectAuthority): Promise<void> => {
    turnBeginning = true
    try {
      await effect?.consume()
      await ensureStarted(effect)
      await effect?.consume()
      effect?.assertLive()
      if (closing || !rpc || !threadId) return
      const state = context.state()
      context.emit({ kind: 'user', text: context.projector.text(text, CODING_EVENT_LIMITS.user) })
      context.update({ status: 'working', reason: undefined, turn: state.turn + 1, turnStartedAt: new Date().toISOString() })
      turn.begin()
      turnActive = true
      const answer = await rpc.request('turn/start', {
        threadId, input: [{ type: 'text', text, text_elements: [] }],
      }, effect).catch(error => {
        if (error instanceof SessionEffectRefused) throw error
        return undefined
      })
      if (!answer) {
        if (turnActive) await finishTurn({ status: 'failed', text: '', isError: true, subtype: 'error', permissionDenials: [] })
        return
      }
      const started = record(answer) && record(answer.turn) ? answer.turn : {}
      if (turnActive && typeof started.id === 'string') {
        turnId ??= started.id
        void sendInterrupt().catch(() => context.log('Original interrupt intent requires reconciliation.'))
      }
    } catch (error) {
      if (error instanceof SessionEffectRefused && turnActive) {
        await stop() // Contain an uncertain transport write; never replay its original intent.
        turnActive = false
        context.update({ status: 'interrupted', reason: 'session_authority_unavailable' })
      }
      throw error
    } finally {
      turnBeginning = false
      if (!turnActive && queue.length && !closing) void drainQueue()
    }
  }

  const stop = async (effect?: SessionEffectAuthority): Promise<void> => {
    const current = agent
    const identity = current?.identity ?? context.state().agentIdentity
    if (!identity) { if (stopDebt) throw stopDebt; return }
    ending = true
    try {
      const snapshot = await context.control.descendants(identity)
      await effect?.consume()
      effect?.assertLive()
      if (current?.alive()) {
        // The app-server leaves when its input ends; anything it leaves behind is stopped below.
        try {
          await current.endInput(effect)
          await Promise.race([current.exited, delay(CLOSE_GRACE_MS)])
        } catch { context.log('Graceful provider shutdown was not acknowledged; checking tree clearance.') }
      }
      await effect?.consume()
      effect?.assertLive()
      const stopped = current
        ? await current.confirmHostExecutionStopped(snapshot, effect)
        : await context.control.stopTree?.(identity, snapshot, effect) === 'stopped'
      if (!stopped) throw new AgentProcessStopUnproved(identity)
      stopDebt = undefined
      if (stopped && agent === current) {
        agent = undefined
        rpc?.failAll()
        rpc = undefined
      }
      threadId = stopped ? undefined : threadId
      if (stopped) context.update({ agentIdentity: undefined })
    } finally {
      ending = false
    }
  }

  return {
    send: async (text, _uuid, effect) => {
      if (turnActive || turnBeginning || starting) {
        queue.push({ text, effect })
        context.update({ queued: queue.length })
        return
      }
      await runTurn(text, effect)
    },
    interrupt: async (reason, effect) => {
      if (!turnActive && !turnBeginning) return
      interrupt ??= { ...(reason ? { reason } : {}), sent: false, effect }
      await sendInterrupt()
    },
    close: async (reason, effect) => {
      closing = true
      await stop(effect)
      queue.length = 0
      if (turnActive) {
        turnActive = false
        context.emit({ kind: 'result', text: '', isError: true, subtype: 'interrupted', permissionDenials: [] })
      }
      context.update({ status: 'closed', reason, queued: 0, turnStartedAt: undefined })
    },
    // The thread outlives its process, so ending the agent ends only the process.
    endIdle: async () => {
      const wasTurn = turnActive
      await stop()
      if (wasTurn) {
        turnActive = false
        turnId = undefined
        await withdrawAsked('expired', 'provider_exited')
      }
    },
    running: () => agent !== undefined || starting !== undefined || stopDebt !== undefined
      || context.state().agentIdentity !== undefined,
    busy: () => turnActive || turnBeginning || starting !== undefined || queue.length > 0,
  }
}
