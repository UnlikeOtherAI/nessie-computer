import type { ExecutorSessionDecision } from '@nessie/executor-protocol'

import type { CodexServerRequest } from './codex-app-connection.js'
import type { Projector } from './projection.js'
import { commandDraft, fileChangeDraft, permissionDraft, questionDraft, type FileChange } from './request-drafts.js'
import { orderedDecisions, type HostAnswer, type SessionRequestDraft } from './session-request-book.js'
import { SESSION_SECRET_SERVER_NAME } from './session-secret-mcp.js'

/**
 * Codex's own requests to its client, as the owner's requests. Verified
 * against codex-cli 0.166.0 for a command: `item/commandExecution/
 * requestApproval` carries the command, its `commandActions` and the
 * `availableDecisions` this policy offers, and is answered `{decision}`.
 * File changes (`item/fileChange/requestApproval`, whose changes arrived on
 * the item before it), widened permissions, `item/tool/requestUserInput`
 * (an `isSecret` question is masked), MCP elicitations and the legacy
 * `execCommandApproval` / `applyPatchApproval` follow the protocol's own
 * shapes. A form elicitation becomes questions only when every field is a
 * choice, a yes/no or free text; anything else, and every URL elicitation,
 * is declined without asking, because it cannot be shown. The session's own
 * `request_secret` server is answered `accept`: its secret request is the
 * owner's gate.
 */

export type CodexRequestPlan =
  /** Answered at once, without the owner. */
  | { kind: 'reply'; result: Record<string, unknown> }
  /** A request this host does not serve: answered with a JSON-RPC error. */
  | { kind: 'unsupported' }
  | {
    kind: 'ask'
    draft: SessionRequestDraft
    answer: (answer: HostAnswer) => { result: Record<string, unknown>; stopsTurn: boolean; feedback?: string }
    withdraw: () => Record<string, unknown>
  }

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const MODERN: Record<string, ExecutorSessionDecision> = {
  accept: 'accept', acceptForSession: 'accept_for_session', decline: 'decline', cancel: 'cancel',
}
const MODERN_ANSWER: Record<ExecutorSessionDecision, string> = {
  accept: 'accept', accept_for_session: 'acceptForSession', decline: 'decline', cancel: 'cancel',
}
const LEGACY_ANSWER: Record<ExecutorSessionDecision, unknown> = {
  accept: 'approved', accept_for_session: 'approved_for_session',
  decline: { denied: { rejection: 'The owner declined this.' } }, cancel: 'abort',
}

/** What the provider offers, in the protocol's order; declining is always possible. */
const offered = (available: unknown): ExecutorSessionDecision[] => orderedDecisions([
  ...(Array.isArray(available) ? available.flatMap((entry) => typeof entry === 'string' && MODERN[entry] ? [MODERN[entry]] : [])
    : ['accept', 'accept_for_session', 'cancel'] as ExecutorSessionDecision[]),
  'decline',
])

const decided = (table: Record<ExecutorSessionDecision, unknown>) => (answer: HostAnswer) => ({
  result: { decision: table[answer.decision ?? 'decline'] }, stopsTurn: answer.decision === 'cancel',
  ...(answer.decision === 'decline' && answer.feedback ? { feedback: answer.feedback } : {}),
})

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A form field Nessie can ask as a question, or undefined. */
const formQuestion = (id: string, value: unknown) => {
  if (!record(value)) return undefined
  const title = textOf(value.title) || id
  const choices = Array.isArray(value.enum) ? value.enum.filter((entry): entry is string => typeof entry === 'string')
    : Array.isArray(value.oneOf) ? value.oneOf.filter(record).map((entry) => textOf(entry.const)).filter(Boolean) : []
  if (choices.length) return { id, type: 'choice', question: title, description: value.description, options: choices }
  if (value.type === 'boolean') return { id, type: 'boolean', question: title, description: value.description, options: ['true', 'false'] }
  if (value.type === 'string') return { id, type: 'string', question: title, description: value.description, options: [] }
  return undefined
}

export const planCodexRequest = (
  request: CodexServerRequest,
  input: { projector: Projector; folder: string; fileChanges: (itemId: string) => FileChange[] },
): CodexRequestPlan => {
  const { method, params } = request
  const { projector, folder } = input
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const modern = method !== 'execCommandApproval'
    const actions = Array.isArray(params.commandActions) ? params.commandActions.filter(record) : []
    const command = actions.length === 1 && typeof actions[0]!.command === 'string' ? actions[0]!.command
      : Array.isArray(params.command) ? params.command.map(textOf).join(' ') : textOf(params.command)
    return {
      kind: 'ask',
      draft: commandDraft({ projector, folder, command, cwd: params.cwd, justification: params.reason,
        decisions: modern ? offered(params.availableDecisions) : ['accept', 'accept_for_session', 'decline', 'cancel'] }),
      answer: decided(modern ? MODERN_ANSWER : LEGACY_ANSWER),
      withdraw: () => ({ decision: modern ? 'cancel' : 'abort' }),
    }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const modern = method !== 'applyPatchApproval'
    const changes = record(params.fileChanges) ? params.fileChanges : {}
    const files: FileChange[] = modern ? input.fileChanges(textOf(params.itemId))
      : Object.entries(changes).map(([path, change]) => ({ path, change: (record(change) && change.type === 'add' ? 'add'
        : record(change) && change.type === 'delete' ? 'delete' : 'update') as FileChange['change'] }))
    const diff = modern ? undefined : Object.values(changes).filter(record).map((change) => textOf(change.unified_diff)).join('\n')
    return {
      kind: 'ask',
      draft: fileChangeDraft({ projector, folder, files, diff, justification: params.reason,
        decisions: ['accept', 'accept_for_session', 'decline', 'cancel'] }),
      answer: decided(modern ? MODERN_ANSWER : LEGACY_ANSWER),
      withdraw: () => ({ decision: modern ? 'cancel' : 'abort' }),
    }
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      kind: 'ask',
      draft: permissionDraft({ projector, tool: 'Wider permissions', input: params.permissions, justification: params.reason,
        title: 'Allow wider file or network access', decisions: ['accept', 'accept_for_session', 'decline', 'cancel'] }),
      answer: (answer) => ({
        result: answer.decision === 'accept' || answer.decision === 'accept_for_session'
          ? { permissions: params.permissions, scope: answer.decision === 'accept_for_session' ? 'session' : 'turn' }
          : { permissions: {}, scope: 'turn' },
        stopsTurn: answer.decision === 'cancel',
      }),
      withdraw: () => ({ permissions: {}, scope: 'turn' }),
    }
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = (Array.isArray(params.questions) ? params.questions : []).filter(record)
    const ids = questions.map((question) => textOf(question.id)).filter(Boolean)
    return {
      kind: 'ask',
      draft: questionDraft({ projector, decisions: ['decline', 'cancel'], questions: questions.map((question) => ({
        id: textOf(question.id), header: question.header, question: question.question,
        options: (Array.isArray(question.options) ? question.options : []).filter(record)
          .map((option) => ({ label: option.label, description: option.description })),
        multiSelect: false, allowCustomAnswer: question.isOther === true || !Array.isArray(question.options)
          || question.options.length === 0 || question.isSecret === true,
        secret: question.isSecret === true,
      })) }),
      answer: (answer) => ({
        result: { answers: Object.fromEntries((answer.answers ?? []).filter((entry) => ids.includes(entry.questionId))
          .map((entry) => [entry.questionId, { answers: entry.values }])) },
        stopsTurn: answer.decision === 'cancel',
      }),
      withdraw: () => ({ answers: {} }),
    }
  }
  if (method === 'mcpServer/elicitation/request') {
    if (params.serverName === SESSION_SECRET_SERVER_NAME) return { kind: 'reply', result: { action: 'accept' } }
    const requested = record(params.requestedSchema) ? params.requestedSchema : {}
    const schema = record(requested.properties) ? requested.properties : {}
    const fields = Object.entries(schema).map(([id, value]) => formQuestion(id, value))
    if (params.mode === 'url' || fields.some((field) => field === undefined)) return { kind: 'reply', result: { action: 'decline' } }
    const known = fields as NonNullable<ReturnType<typeof formQuestion>>[]
    const server = projector.line(params.serverName, 80)
    const ask = known.length === 0
      ? permissionDraft({ projector, tool: server, input: undefined, title: textOf(params.message) || `Allow ${server}`,
        justification: params.message, decisions: ['accept', 'decline', 'cancel'] })
      : questionDraft({ projector, title: textOf(params.message) || undefined, decisions: ['decline', 'cancel'],
        questions: known.map((field) => ({ id: field.id, question: field.question, header: server,
          options: field.options.map((label) => ({ label })),
          multiSelect: false, allowCustomAnswer: field.type === 'string', secret: false })) })
    return {
      kind: 'ask',
      draft: ask,
      answer: (answer) => {
        if (answer.decision && answer.decision !== 'accept') {
          return { result: { action: answer.decision === 'cancel' ? 'cancel' : 'decline' }, stopsTurn: answer.decision === 'cancel' }
        }
        const values = new Map((answer.answers ?? []).map((entry) => [entry.questionId, entry.values[0] ?? '']))
        const content = Object.fromEntries(known.map((field) => [field.id,
          field.type === 'boolean' ? values.get(field.id) === 'true' : values.get(field.id) ?? '']))
        return { result: { action: 'accept', ...(known.length ? { content } : {}) }, stopsTurn: false }
      },
      withdraw: () => ({ action: 'cancel' }),
    }
  }
  return { kind: 'unsupported' }
}
