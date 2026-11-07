import { randomUUID } from 'node:crypto'

import {
  EXECUTOR_SESSION_REQUEST_MAXIMUM, ExecutorSessionRequestSchema,
  type ExecutorSessionAnswer, type ExecutorSessionDecision, type ExecutorSessionRequest,
} from '@nessie/executor-protocol'

/**
 * What a session host's coding agent is waiting on its owner for, and what
 * became of it (`executor-session-requests.ts` in the protocol).
 *
 * The host is the only writer. A provider's driver opens a request with the
 * one function that answers the provider; the owner's answer reaches the host
 * through its inbox and is checked against the request once more here, so a
 * request is answered at most once whichever way the race goes. A request
 * ends unanswered when its turn is interrupted (`turn_interrupted`), the
 * session closes (`session_closed`), the provider exits (`provider_exited`)
 * or withdraws it (`provider_cancelled`), or a host finds it pending from an
 * earlier host whose provider went with it (`executor_restarted`).
 *
 * The book keeps every pending request and the most recent settled ones up to
 * the protocol's cap, so a card can say what happened; older settled requests
 * age out as new ones settle.
 */

export type SessionRequestDraft = Omit<ExecutorSessionRequest, 'id' | 'status' | 'reason' | 'openedAt' | 'answerable'>
  & { answerable?: boolean }

/** The answer as the host receives it: a secret's value never reaches the host, only that it was saved. */
export type HostAnswer = Omit<ExecutorSessionAnswer, 'secret'> & { secretSaved?: true }

export type SessionRequestResponder = {
  answer: (answer: HostAnswer) => void
  /** The request ended unanswered; the provider is told so if it still listens. */
  withdraw: (status: 'cancelled' | 'expired', reason: string) => void
}

export type AnswerProblem = 'request_not_pending' | 'request_not_answerable' | 'answer_shape_mismatch'

const APPROVAL_KINDS = new Set(['command', 'file_change', 'permission'])

/**
 * Why an answer cannot settle a request, or undefined when it can: the
 * request must be pending and answerable, and the answer must have the
 * request's own shape — a decision the request offers, every question
 * answered once with values it accepts, or a secret for a secret.
 */
export const answerProblem = (
  request: ExecutorSessionRequest | undefined, answer: ExecutorSessionAnswer | HostAnswer,
): AnswerProblem | undefined => {
  if (!request || request.status !== 'pending') return 'request_not_pending'
  if (!request.answerable) return 'request_not_answerable'
  const secret = 'secret' in answer && answer.secret !== undefined || 'secretSaved' in answer && answer.secretSaved
  if (APPROVAL_KINDS.has(request.kind)) {
    if (answer.decision === undefined || answer.answers !== undefined || secret) return 'answer_shape_mismatch'
    return (request.decisions ?? []).includes(answer.decision) ? undefined : 'answer_shape_mismatch'
  }
  // A question or a secret may also be turned down, when it offers that decision.
  if (answer.decision !== undefined) {
    return answer.answers === undefined && !secret && (request.decisions ?? []).includes(answer.decision)
      ? undefined : 'answer_shape_mismatch'
  }
  if (request.kind === 'secret') return secret && answer.answers === undefined ? undefined : 'answer_shape_mismatch'
  if (!answer.answers || secret) return 'answer_shape_mismatch'
  const questions = request.questions ?? []
  const given = new Map(answer.answers.map((entry) => [entry.questionId, entry.values]))
  if (given.size !== answer.answers.length || given.size !== questions.length) return 'answer_shape_mismatch'
  for (const question of questions) {
    const values = given.get(question.id)
    if (!values || (!question.multiSelect && values.length !== 1)) return 'answer_shape_mismatch'
    const labels = new Set(question.options.map((option) => option.label))
    if (!question.allowCustomAnswer && values.some((value) => !labels.has(value))) return 'answer_shape_mismatch'
  }
  return undefined
}

type Entry = { request: ExecutorSessionRequest; responder?: SessionRequestResponder; settled: number }

export class SessionRequestBook {
  #entries: Entry[] = []
  #settled = 0

  constructor(
    private readonly changed: (requests: ExecutorSessionRequest[]) => void,
    previous: readonly ExecutorSessionRequest[] = [],
  ) {
    // An earlier host's provider went with it, so nothing it left pending can be answered.
    for (const request of previous) {
      const parsed = ExecutorSessionRequestSchema.safeParse(request.status === 'pending'
        ? { ...request, status: 'expired', reason: 'executor_restarted' } : request)
      if (parsed.success) this.#entries.push({ request: parsed.data, settled: (this.#settled += 1) })
    }
    if (previous.some((request) => request.status === 'pending')) this.publish()
  }

  /** Opens a request; the draft's text must already be projected and within the protocol's bounds. */
  open(draft: SessionRequestDraft, responder: SessionRequestResponder): ExecutorSessionRequest {
    const request = ExecutorSessionRequestSchema.parse({
      ...draft, id: `req-${randomUUID()}`, status: 'pending', answerable: draft.answerable ?? true,
      openedAt: new Date().toISOString(),
    })
    this.#entries.push({ request, responder, settled: 0 })
    this.publish()
    return request
  }

  get(id: string): ExecutorSessionRequest | undefined {
    return this.#entries.find((entry) => entry.request.id === id)?.request
  }

  /** Settles the request with the owner's answer and hands it to the provider; a problem changes nothing. */
  answer(answer: HostAnswer): AnswerProblem | undefined {
    const entry = this.#entries.find((candidate) => candidate.request.id === answer.requestId)
    const problem = answerProblem(entry?.request, answer)
    if (problem || !entry) return problem ?? 'request_not_pending'
    this.settle(entry, 'answered')
    entry.responder?.answer(answer)
    return undefined
  }

  /** The provider resolved or withdrew one request itself. */
  withdraw(id: string, status: 'cancelled' | 'expired', reason: string): void {
    const entry = this.#entries.find((candidate) => candidate.request.id === id && candidate.request.status === 'pending')
    if (!entry) return
    this.settle(entry, status, reason)
    entry.responder?.withdraw(status, reason)
  }

  /** Ends every pending request unanswered; answers the provider for each that still listens. */
  withdrawAll(status: 'cancelled' | 'expired', reason: string): number {
    const pending = this.#entries.filter((entry) => entry.request.status === 'pending')
    for (const entry of pending) this.withdraw(entry.request.id, status, reason)
    return pending.length
  }

  hasPending(): boolean { return this.#entries.some((entry) => entry.request.status === 'pending') }

  /** Pending first, oldest first; then the most recent settled, newest last; at most the protocol's cap. */
  list(): ExecutorSessionRequest[] {
    const pending = this.#entries.filter((entry) => entry.request.status === 'pending')
      .sort((left, right) => left.request.openedAt.localeCompare(right.request.openedAt))
    const room = Math.max(0, EXECUTOR_SESSION_REQUEST_MAXIMUM - pending.length)
    const settled = room === 0 ? [] : this.#entries.filter((entry) => entry.request.status !== 'pending')
      .sort((left, right) => left.settled - right.settled).slice(-room)
    return [...pending.slice(0, EXECUTOR_SESSION_REQUEST_MAXIMUM), ...settled].map((entry) => entry.request)
  }

  private settle(entry: Entry, status: Exclude<ExecutorSessionRequest['status'], 'pending'>, reason?: string): void {
    entry.request = { ...entry.request, status, ...(reason ? { reason } : {}) }
    entry.settled = (this.#settled += 1)
    // Aged-out settled requests are forgotten, so a long session's book stays bounded.
    const kept = new Set(this.list())
    this.#entries = this.#entries.filter((candidate) => kept.has(candidate.request) || candidate.request.status === 'pending')
    this.publish()
  }

  private publish(): void { this.changed(this.list()) }
}

/** The decisions an approval offers, in the protocol's order, from what the provider accepts. */
export const orderedDecisions = (offered: Iterable<ExecutorSessionDecision>): ExecutorSessionDecision[] => {
  const set = new Set(offered)
  return (['accept', 'accept_for_session', 'decline', 'cancel'] as const).filter((decision) => set.has(decision))
}
