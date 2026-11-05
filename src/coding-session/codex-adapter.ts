import type { CodingAgentConfig } from './config.js'
import { CODING_EVENT_LIMITS, looksLikeTestCommand, type Projector } from './projection.js'
import type { CodingEventBody, CodingPermissionDenial, CodingSessionResult } from './types.js'

/**
 * Codex's `exec --json` protocol: one process per turn, the prompt on stdin.
 *
 * Verified against codex-cli 0.155.1 on the failure path (its ChatGPT quota
 * was exhausted when this was written): a turn prints `thread.started`,
 * `turn.started`, then `error` and `turn.failed`, and exits 1. Resuming an
 * unknown thread prints only to stderr ("no rollout found") and exits 1.
 * `exec resume` refuses `--sandbox` after the subcommand, so the owner's
 * reviewed `args` go before `resume`, where `exec` itself parses them.
 *
 * The item shapes are those in the 0.155.1 binary and stay unverified until a
 * live turn can run; anything this does not recognise is kept as a `system`
 * event naming only its type.
 */

export const codexArguments = (
  agent: CodingAgentConfig,
  input: { folder: string; threadId?: string },
): string[] => [
  ...agent.command.slice(1),
  'exec',
  ...agent.args,
  ...(agent.model === undefined ? [] : ['-m', agent.model]),
  '-C', input.folder,
  ...(input.threadId === undefined ? [] : ['resume', input.threadId]),
  '--json',
  '-',
]

export type CodexSignals = {
  events: CodingEventBody[]
  threadId?: string
  turnEnded?: true
  test?: { command: string; exitCode: number | null }
}

export type CodexTurnState = {
  accept: (line: string) => CodexSignals
  /** The turn's result once the process has exited. */
  finish: (exit: { code: number | null; interrupted: boolean }) => CodingSessionResult
}

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

export const createCodexTurnState = (projector: Projector): CodexTurnState => {
  let lastMessage = ''
  // A command or an edit the sandbox or the approval policy refused, which the
  // result carries as permissionDenials the way Claude's does.
  const denials: CodingPermissionDenial[] = []
  let outcome: CodingSessionResult | undefined
  const started = Date.now()

  const acceptItem = (type: string, item: Record<string, unknown>, signals: CodexSignals): void => {
    const completed = type === 'item.completed'
    if (item.type === 'agent_message' && completed) {
      lastMessage = projector.text(item.text, CODING_EVENT_LIMITS.result)
      signals.events.push({ kind: 'assistant', text: projector.text(item.text, CODING_EVENT_LIMITS.assistant) })
    } else if (item.type === 'command_execution') {
      const command = projector.line(item.command, CODING_EVENT_LIMITS.tool)
      if (type === 'item.started') {
        signals.events.push({ kind: 'tool', name: 'shell', summary: command })
      } else if (completed && item.status === 'declined') {
        if (denials.length < 20) denials.push({ tool: 'shell', summary: command })
        signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: 'shell' })
      } else if (completed) {
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
        const isError = exitCode !== undefined && exitCode !== 0
        signals.events.push({
          kind: 'tool_result', name: 'shell', summary: projector.toolResult(item.aggregated_output, isError),
          ...(isError ? { isError: true as const } : {}), ...(exitCode === undefined ? {} : { exitCode }),
        })
        if (typeof item.command === 'string' && looksLikeTestCommand(item.command)) {
          signals.test = { command, exitCode: exitCode ?? null }
        }
      }
    } else if (item.type === 'file_change' && completed) {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const summary = projector.line(changes.slice(0, 10).map((change: unknown) => (
        record(change) ? `${projector.line(change.kind, 20)} ${projector.line(change.path, 200)}` : ''
      )).filter(Boolean).join(', '), CODING_EVENT_LIMITS.tool)
      if (item.status === 'declined') {
        if (denials.length < 20) denials.push({ tool: 'edit', summary })
        signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: 'edit' })
      } else {
        signals.events.push({ kind: 'tool', name: 'edit', summary })
      }
    } else if (item.type === 'mcp_tool_call' && type === 'item.started') {
      const name = `mcp:${projector.line(item.server, 40)}.${projector.line(item.tool, 40)}`
      signals.events.push({ kind: 'tool', name, summary: '' })
    } else if (item.type === 'web_search' && type === 'item.started') {
      signals.events.push({ kind: 'tool', name: 'web_search', summary: projector.line(item.query, CODING_EVENT_LIMITS.tool) })
    } else if (item.type === 'error' && completed) {
      signals.events.push({ kind: 'system', subtype: 'error', message: projector.line(item.message, CODING_EVENT_LIMITS.system) })
    }
    // reasoning and todo_list carry nothing the supervisor needs.
  }

  return {
    accept: (text) => {
      const signals: CodexSignals = { events: [] }
      let event: unknown
      try {
        event = JSON.parse(text)
      } catch {
        return signals
      }
      if (!record(event) || typeof event.type !== 'string') return signals
      if (event.type === 'thread.started') {
        if (typeof event.thread_id === 'string') signals.threadId = event.thread_id
      } else if (event.type === 'turn.started') {
        // The status already says working.
      } else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        if (record(event.item)) acceptItem(event.type, event.item, signals)
      } else if (event.type === 'turn.completed') {
        outcome = { text: lastMessage, isError: false, subtype: 'success', permissionDenials: denials }
        signals.turnEnded = true
      } else if (event.type === 'turn.failed') {
        const message = record(event.error) ? event.error.message : undefined
        outcome = {
          text: projector.text(message, CODING_EVENT_LIMITS.result), isError: true, subtype: 'error', permissionDenials: denials,
        }
        signals.turnEnded = true
      } else if (event.type === 'error') {
        signals.events.push({ kind: 'system', subtype: 'error', message: projector.line(event.message, CODING_EVENT_LIMITS.system) })
      } else {
        signals.events.push({ kind: 'system', subtype: 'unrecognized', message: projector.line(event.type, 80) })
      }
      return signals
    },
    finish: (exit) => {
      const durationMs = Date.now() - started
      if (exit.interrupted) {
        return { text: lastMessage, isError: true, subtype: 'interrupted', durationMs, permissionDenials: denials }
      }
      if (outcome) return { ...outcome, durationMs }
      return { text: lastMessage, isError: true, subtype: 'agent_exited', durationMs, permissionDenials: denials }
    },
  }
}
