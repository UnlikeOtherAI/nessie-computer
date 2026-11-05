import type { CodingAgentConfig } from './config.js'
import { CODING_EVENT_LIMITS, exitCodeFromToolResult, looksLikeTestCommand, type Projector } from './projection.js'
import type { CodingEventBody, CodingSessionResult } from './types.js'

/**
 * Claude Code's `-p` stream-json protocol, as verified against 2.1.280
 * (the probe transcripts are summarised in docs/executor-protocol/host-coding-sessions.md).
 *
 * This module is pure: it builds the argv, encodes what we write to stdin and
 * folds each stdout line into projected events plus the few signals the driver
 * acts on. The process itself belongs to `claude-driver.ts`.
 */

/** Appended to Claude's system prompt: who is driving and what a turn should end with. */
export const CLAUDE_APPENDED_SYSTEM_PROMPT = [
  'A Nessie agent is driving this session on behalf of the machine\'s owner.',
  'There is no person at this terminal, so nobody can answer a question or a permission prompt here;',
  'anything that would need approval is denied.',
  'Work in your own git worktree rather than on the checked-out branch, and commit and push as your instructions say.',
  'End each turn with a short summary of what you did and what you need.',
].join(' ')

const INITIALIZE_ID = 'nessie-initialize'
const INTERRUPT_ID = 'nessie-interrupt'
const END_ID = 'nessie-end-session'

export const claudeArguments = (
  agent: CodingAgentConfig,
  input: { sessionId: string; resume: boolean; maxBudgetUsd?: number },
): string[] => [
  ...agent.command.slice(1),
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
  input.resume ? '--resume' : '--session-id', input.sessionId,
  // Verified on 2.1.280: anything that would prompt is denied without a
  // control request, and the denial is carried in the result's
  // `permission_denials`. The driving model never answers a prompt.
  '--permission-prompts', 'none',
  ...(agent.permissionMode === undefined ? [] : ['--permission-mode', agent.permissionMode]),
  ...(agent.allowedTools.length === 0 ? [] : ['--allowedTools', ...agent.allowedTools]),
  ...(agent.disallowedTools.length === 0 ? [] : ['--disallowedTools', ...agent.disallowedTools]),
  ...(agent.model === undefined ? [] : ['--model', agent.model]),
  ...(input.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(input.maxBudgetUsd)]),
  ...agent.args,
  '--append-system-prompt', CLAUDE_APPENDED_SYSTEM_PROMPT,
]

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

export const claudeUserLine = (uuid: string, text: string): string => line({
  type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '',
})

export const claudeControlLine = (subtype: 'initialize' | 'interrupt' | 'end_session'): string => line({
  type: 'control_request',
  request_id: subtype === 'initialize' ? INITIALIZE_ID : subtype === 'interrupt' ? INTERRUPT_ID : END_ID,
  request: { subtype },
})

/** The answer to a permission prompt if one arrives anyway: always deny, never updated permissions. */
export const claudeDenyLine = (requestId: string, supported: boolean): string => line(supported
  ? {
    type: 'control_response',
    response: {
      subtype: 'success', request_id: requestId,
      response: { behavior: 'deny', message: 'No person is at this terminal to approve this, so it was denied.' },
    },
  }
  : { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'unsupported' } })

export type ClaudeSignals = {
  events: CodingEventBody[]
  ready?: true
  initializeFailed?: true
  interruptAcknowledged?: true
  /** How many background tasks run now, whenever that changes. */
  backgroundTasks?: number
  endAcknowledged?: true
  agentSessionId?: string
  /** The agent is working on a turn, whether or not we asked it to. */
  active?: true
  turnFinished?: CodingSessionResult
  answerControlRequest?: { requestId: string; supported: boolean }
  test?: { command: string; exitCode: number | null }
}

export type ClaudeStreamState = {
  accept: (line: string) => ClaudeSignals
  noteSent: (uuid: string) => void
  busy: () => boolean
  backgroundTasks: () => number
  /** What this process has spent so far: the CLI's own running total. */
  processCostUsd: () => number
}

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event', 'keep_alive'])

/** The uuids an interrupt answer says are still queued; its entries are ids or records carrying one. */
const stillQueued = (response: Record<string, unknown>): Set<string> => {
  const answer = record(response.response) ? response.response : {}
  const entries = Array.isArray(answer.still_queued) ? answer.still_queued : []
  return new Set(entries.flatMap((entry: unknown) => {
    if (typeof entry === 'string') return [entry]
    if (!record(entry)) return []
    const uuid = entry.uuid ?? entry.command_uuid
    return typeof uuid === 'string' ? [uuid] : []
  }))
}

/**
 * Turn accounting. Messages and results do not map one to one: two messages
 * written back to back become one turn, a follow-up written during a tool call
 * folds into the running turn, and a finished background task starts a turn
 * nobody asked for. So a turn is finished once a result has arrived and no
 * message of ours is still queued. A command that had *started* when the
 * result arrived was part of that turn, however late its `completed`
 * lifecycle event turns up.
 *
 * Background tasks do not hold a turn open: a dev server or a watcher runs
 * for as long as the agent lives, and a turn waiting on one would never end.
 * Their count is reported instead, and the turn one of them starts when it
 * finishes is reported as its own. An interrupt cancels the messages still
 * waiting to start, except those its answer lists as still queued, so a
 * message the CLI dropped never keeps the session busy.
 */
export const createClaudeStreamState = (projector: Projector): ClaudeStreamState => {
  const commands = new Map<string, 'sent' | 'queued' | 'started'>()
  const toolNames = new Map<string, string>()
  const testCommands = new Map<string, string>()
  let backgroundTasks = 0
  let active = false
  let pendingResult: CodingSessionResult | undefined
  let processCostUsd = 0
  let lastInit = ''

  const finish = (signals: ClaudeSignals): void => {
    if (!pendingResult || commands.size > 0) return
    signals.turnFinished = pendingResult
    pendingResult = undefined
    active = false
    toolNames.clear()
    testCommands.clear()
  }

  const acceptSystem = (event: Record<string, unknown>, signals: ClaudeSignals): void => {
    if (event.subtype === 'init') {
      if (typeof event.session_id === 'string') signals.agentSessionId = event.session_id
      const model = projector.line(event.model, 100)
      const permissionMode = projector.line(event.permissionMode, 40)
      if (`${model}|${permissionMode}` !== lastInit) {
        lastInit = `${model}|${permissionMode}`
        signals.events.push({ kind: 'system', subtype: 'init', ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) })
      }
      signals.active = true
      active = true
      return
    }
    if (event.subtype === 'permission_denied') {
      signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: projector.line(event.tool_name, 80) })
      return
    }
    if (event.subtype === 'task_notification') {
      signals.events.push({ kind: 'system', subtype: 'task', message: projector.line(event.summary, CODING_EVENT_LIMITS.tool) })
      return
    }
    if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      backgroundTasks = event.tasks.length
      signals.backgroundTasks = backgroundTasks
    }
    // status, thinking_tokens, task_started, task_updated and the rest carry
    // nothing the supervisor reads, and some carry host paths.
  }

  const acceptAssistant = (event: Record<string, unknown>, signals: ClaudeSignals): void => {
    const content = record(event.message) && Array.isArray(event.message.content) ? event.message.content : []
    for (const block of content) {
      if (!record(block)) continue
      if (block.type === 'text') {
        const text = projector.text(block.text, CODING_EVENT_LIMITS.assistant)
        if (text) signals.events.push({ kind: 'assistant', text })
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const name = projector.line(block.name, 80)
        if (typeof block.id === 'string') toolNames.set(block.id, name)
        const summary = projector.toolInput(block.name, block.input)
        signals.events.push({ kind: 'tool', name, summary })
        const command = record(block.input) ? block.input.command : undefined
        if (typeof block.id === 'string' && typeof command === 'string' && looksLikeTestCommand(command)) {
          testCommands.set(block.id, summary)
        }
      }
    }
    signals.active = true
    active = true
  }

  const acceptUser = (event: Record<string, unknown>, signals: ClaudeSignals): void => {
    const message = record(event.message) ? event.message : {}
    if (event.isReplay === true) {
      // The echo proves the CLI took the message into a turn, lifecycle event or not.
      if (typeof event.uuid === 'string' && commands.has(event.uuid)) commands.set(event.uuid, 'started')
      const content = message.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.map((block: unknown) => (record(block) && typeof block.text === 'string' ? block.text : '')).join('\n')
        : ''
      signals.events.push({ kind: 'user', text: projector.text(text, CODING_EVENT_LIMITS.user) })
      return
    }
    if (!Array.isArray(message.content)) return
    for (const block of message.content) {
      if (!record(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const isError = block.is_error === true
      const name = toolNames.get(id)
      signals.events.push({
        kind: 'tool_result',
        ...(name ? { name } : {}),
        summary: projector.toolResult(block.content, isError),
        ...(isError ? { isError: true as const } : {}),
      })
      const command = testCommands.get(id)
      if (command !== undefined) signals.test = { command, exitCode: exitCodeFromToolResult(block.content, isError) }
    }
  }

  const acceptResult = (event: Record<string, unknown>, signals: ClaudeSignals): void => {
    const total = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined
    const costUsd = total === undefined ? undefined : Math.max(0, Math.round((total - processCostUsd) * 1e6) / 1e6)
    if (total !== undefined) processCostUsd = total
    const origin = record(event.origin) && typeof event.origin.kind === 'string' ? projector.line(event.origin.kind, 40) : undefined
    const result: CodingSessionResult = {
      text: projector.text(event.result, CODING_EVENT_LIMITS.result),
      isError: event.is_error === true,
      subtype: projector.line(event.subtype, 60) || 'unknown',
      ...(typeof event.num_turns === 'number' ? { turns: event.num_turns } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
      permissionDenials: projector.denials(event.permission_denials),
      ...(origin ? { origin } : {}),
    }
    signals.events.push({ kind: 'result', ...result })
    for (const [uuid, state] of commands) if (state === 'started') commands.delete(uuid)
    pendingResult = result
    finish(signals)
  }

  return {
    noteSent: (uuid) => {
      commands.set(uuid, 'sent')
      active = true
    },
    busy: () => active || commands.size > 0 || pendingResult !== undefined,
    backgroundTasks: () => backgroundTasks,
    processCostUsd: () => processCostUsd,
    accept: (text) => {
      const signals: ClaudeSignals = { events: [] }
      let event: unknown
      try {
        event = JSON.parse(text)
      } catch {
        return signals
      }
      if (!record(event) || typeof event.type !== 'string') return signals
      switch (event.type) {
        case 'control_response': {
          const response = record(event.response) ? event.response : {}
          if (response.request_id === INITIALIZE_ID) {
            if (response.subtype === 'success') signals.ready = true
            else signals.initializeFailed = true
            // The answer itself is dropped. Its account's e-mail and organisation
            // are read for one thing: to become redactions, because the model
            // knows who is logged in and repeats it (see projection.ts).
            const answer = record(response.response) ? response.response : {}
            const account = record(answer.account) ? answer.account : {}
            projector.redact([account.email, account.organization])
          }
          if (response.request_id === INTERRUPT_ID) {
            signals.interruptAcknowledged = true
            const kept = stillQueued(response)
            let cancelled = 0
            for (const [uuid, state] of commands) {
              if (state === 'started' || kept.has(uuid)) continue
              commands.delete(uuid)
              cancelled += 1
            }
            if (cancelled > 0) {
              signals.events.push({ kind: 'system', subtype: 'cancelled', message: `${cancelled} message(s) had not started and were cancelled by the interrupt.` })
            }
            finish(signals)
          }
          if (response.request_id === END_ID) signals.endAcknowledged = true
          break
        }
        case 'control_request': {
          const request = record(event.request) ? event.request : {}
          if (typeof event.request_id !== 'string') break
          const supported = request.subtype === 'can_use_tool'
          signals.answerControlRequest = { requestId: event.request_id, supported }
          if (supported) {
            signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: projector.line(request.tool_name, 80) })
          }
          break
        }
        case 'system':
          acceptSystem(event, signals)
          break
        case 'command_lifecycle': {
          const uuid = typeof event.command_uuid === 'string' ? event.command_uuid : undefined
          if (!uuid) break
          if (event.state === 'completed') commands.delete(uuid)
          else if (event.state === 'queued' && commands.get(uuid) !== 'started') commands.set(uuid, 'queued')
          else if (event.state === 'started') {
            commands.set(uuid, 'started')
            signals.active = true
            active = true
          }
          finish(signals)
          break
        }
        case 'assistant':
          acceptAssistant(event, signals)
          break
        case 'user':
          acceptUser(event, signals)
          break
        case 'result':
          acceptResult(event, signals)
          break
        default:
          if (!DROPPED_TYPES.has(event.type)) {
            signals.events.push({ kind: 'system', subtype: 'unrecognized', message: projector.line(event.type, 80) })
          }
      }
      return signals
    },
  }
}
