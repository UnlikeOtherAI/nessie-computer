import type { CodingAgentConfig } from './config.js'
import type { CodexNotification } from './codex-app-connection.js'
import { CODING_EVENT_LIMITS, looksLikeTestCommand, type Projector } from './projection.js'
import type { CodingEventBody, CodingPermissionDenial, CodingSessionResult } from './types.js'

/**
 * Codex's `app-server` protocol, as verified against codex-cli 0.166.0: one
 * long-lived process per session, JSON-RPC over stdio. `thread/start` (or
 * `thread/resume` for a session that has one) takes the sandbox and approval
 * policy, `turn/start` begins a turn, `turn/interrupt` stops it, and the
 * server's own requests are its prompts (`codex-requests.ts`). A turn reports
 * `item/started` and `item/completed` for its commands, file changes, tool
 * calls and messages, and ends with `turn/completed` carrying its status:
 * `completed`, `interrupted` or `failed` with an `error`.
 *
 * The reviewed arguments say which stance Codex takes, and they become
 * `thread/start`'s parameters here rather than `exec` flags. The sandbox is
 * the reviewed one, always. Approvals ask the owner before Codex leaves it —
 * never a wider sandbox, and never `never` where the stance asked first.
 * An argument this mapping does not know refuses the start rather than being
 * dropped: what a person reviewed must be what runs.
 */

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexPolicy = { sandbox: CodexSandbox; approvalPolicy: 'never' | 'on-request'; approvalsReviewer?: 'auto_review' }

const SANDBOXES = new Set<string>(['read-only', 'workspace-write', 'danger-full-access'])
/** `exec`-only flags with nothing to say to an app-server. */
const IGNORED = new Set(['--skip-git-repo-check'])

/** The stance the reviewed arguments take, as `coding-sessions-policy.ts` names it in the descriptor. */
export const codexPolicy = (args: readonly string[]): CodexPolicy | { unsupported: string } => {
  let policy: CodexPolicy = { sandbox: 'read-only', approvalPolicy: 'on-request' }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--dangerously-bypass-approvals-and-sandbox' || argument === '--yolo') {
      policy = { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    } else if (argument === '--full-auto') {
      policy = { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    } else if (argument === '--approve-for-me') {
      policy = { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    } else if (argument === '--sandbox' || argument === '-s' || argument.startsWith('--sandbox=')
      || (argument.startsWith('-s') && argument.length > 2)) {
      const value = argument.startsWith('--sandbox=') ? argument.slice(10)
        : argument.length > 2 && argument.startsWith('-s') ? argument.slice(2) : args[(index += 1)]
      if (!value || !SANDBOXES.has(value)) return { unsupported: argument }
      policy = { ...policy, sandbox: value as CodexSandbox }
    } else if (!IGNORED.has(argument)) {
      return { unsupported: argument }
    }
  }
  return policy
}

export const codexAppServerArguments = (agent: CodingAgentConfig): string[] => [...agent.command.slice(1), 'app-server']

export type CodexSignals = {
  events: CodingEventBody[]
  turnId?: string
  turnEnded?: CodingSessionResult & { status: 'completed' | 'interrupted' | 'failed' }
  test?: { command: string; exitCode: number | null }
  /** The server withdrew one of its own requests (`serverRequest/resolved`). */
  resolvedRequest?: string | number
}

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const changeKind = (value: unknown): string => (record(value) && typeof value.type === 'string' ? value.type : 'update')

/** One turn's events, and its result when it ends. */
export const createCodexTurnState = (projector: Projector) => {
  let lastMessage = ''
  let denials: CodingPermissionDenial[] = []
  let started = Date.now()

  const item = (method: string, value: Record<string, unknown>, signals: CodexSignals): void => {
    const completed = method === 'item/completed'
    if (value.type === 'agentMessage' && completed) {
      if (typeof value.text === 'string' && value.text.trim()) {
        lastMessage = projector.text(value.text, CODING_EVENT_LIMITS.result)
        signals.events.push({ kind: 'assistant', text: projector.text(value.text, CODING_EVENT_LIMITS.assistant) })
      }
    } else if (value.type === 'commandExecution') {
      const command = projector.line(value.command, CODING_EVENT_LIMITS.tool)
      if (!completed) signals.events.push({ kind: 'tool', name: 'shell', summary: command })
      else if (value.status === 'declined') {
        if (denials.length < 20) denials.push({ tool: 'shell', summary: command })
        signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: 'shell' })
      } else {
        const exitCode = typeof value.exitCode === 'number' ? value.exitCode : undefined
        const isError = value.status === 'failed' || (exitCode !== undefined && exitCode !== 0)
        signals.events.push({
          kind: 'tool_result', name: 'shell', summary: projector.toolResult(value.aggregatedOutput ?? '', isError),
          ...(isError ? { isError: true as const } : {}), ...(exitCode === undefined ? {} : { exitCode }),
        })
        if (typeof value.command === 'string' && looksLikeTestCommand(value.command)) {
          signals.test = { command, exitCode: exitCode ?? null }
        }
      }
    } else if (value.type === 'fileChange' && completed) {
      const changes = Array.isArray(value.changes) ? value.changes : []
      const summary = projector.line(changes.slice(0, 10).map((change: unknown) => (
        record(change) ? `${changeKind(change.kind)} ${projector.line(change.path, 200)}` : ''
      )).filter(Boolean).join(', '), CODING_EVENT_LIMITS.tool)
      if (value.status === 'declined') {
        if (denials.length < 20) denials.push({ tool: 'edit', summary })
        signals.events.push({ kind: 'system', subtype: 'permission_denied', tool: 'edit' })
      } else signals.events.push({ kind: 'tool', name: 'edit', summary })
    } else if (value.type === 'mcpToolCall' && !completed) {
      signals.events.push({ kind: 'tool', name: `mcp:${projector.line(value.server, 40)}.${projector.line(value.tool, 40)}`, summary: '' })
    } else if (value.type === 'webSearch' && !completed) {
      signals.events.push({ kind: 'tool', name: 'web_search', summary: projector.line(value.query, CODING_EVENT_LIMITS.tool) })
    }
    // Reasoning, plans and user messages carry nothing the supervisor needs.
  }

  return {
    begin: (): void => { lastMessage = ''; denials = []; started = Date.now() },
    accept: (notification: CodexNotification): CodexSignals => {
      const signals: CodexSignals = { events: [] }
      const { method, params } = notification
      if (method === 'turn/started' && record(params.turn) && typeof params.turn.id === 'string') {
        signals.turnId = params.turn.id
      } else if ((method === 'item/started' || method === 'item/completed') && record(params.item)) {
        item(method, params.item, signals)
      } else if (method === 'error' && params.willRetry !== true) {
        const error = record(params.error) ? params.error.message : undefined
        signals.events.push({ kind: 'system', subtype: 'error', message: projector.line(error, CODING_EVENT_LIMITS.system) })
      } else if (method === 'serverRequest/resolved' && (typeof params.requestId === 'number' || typeof params.requestId === 'string')) {
        signals.resolvedRequest = params.requestId
      } else if (method === 'turn/completed' && record(params.turn)) {
        const status = params.turn.status === 'interrupted' ? 'interrupted' : params.turn.status === 'failed' ? 'failed' : 'completed'
        const error = record(params.turn.error) ? params.turn.error.message : undefined
        const durationMs = Date.now() - started
        signals.turnEnded = status === 'failed'
          ? { status, text: projector.text(error, CODING_EVENT_LIMITS.result) || lastMessage, isError: true, subtype: 'error', durationMs,
            permissionDenials: denials }
          : { status, text: lastMessage, isError: status === 'interrupted', subtype: status === 'interrupted' ? 'interrupted' : 'success',
            durationMs, permissionDenials: denials }
      }
      return signals
    },
  }
}
