import type { SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'

import {
  EXECUTOR_SESSION_REQUEST_MAXIMUM, ExecutorSessionRequestSchema,
  executorSessionAnswerProblem, type ExecutorSessionAnswer, type ExecutorSessionAnswerProblem,
  type ExecutorSessionDecision, type ExecutorSessionRequest,
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

/**
 * The answer as the host receives it: a secret's value is in its file, and
 * reaches the host only sealed, so it can be redacted (`answer-seal.ts`).
 */
export type HostAnswer = Omit<ExecutorSessionAnswer, 'secret'> & { secretSaved?: true; sealed?: unknown }

export type SessionRequestResponder = {
  answer: (answer: HostAnswer, effect?: SessionEffectAuthority) => void
  /** The request ended unanswered; the provider is told so if it still listens. */
  withdraw: (status: 'cancelled' | 'expired', reason: string) => void
}

export type AnswerProblem = ExecutorSessionAnswerProblem

/** The protocol's one answer rule, for an answer as the host holds it. */
export const answerProblem = (
  request: ExecutorSessionRequest | undefined, answer: ExecutorSessionAnswer | HostAnswer,
): AnswerProblem | undefined => executorSessionAnswerProblem(request, {
  answers: answer.answers, decision: answer.decision,
  secret: 'secret' in answer && answer.secret !== undefined || 'secretSaved' in answer && answer.secretSaved === true,
})

type Entry = { request: ExecutorSessionRequest; responder?: SessionRequestResponder; settled: number }

export class SessionRequestBook {
  #entries: Entry[] = []
  #settled = 0

  constructor(
    private readonly changed: (requests: ExecutorSessionRequest[]) => void,
    previous: readonly ExecutorSessionRequest[] = [],
    /** Whether the owner can be asked at all now (`owner-requests-lease.ts`); a request opens only while true. */
    private readonly reachable: () => boolean = () => true,
  ) {
    // An earlier host's provider went with it, so nothing it left pending can be answered.
    for (const request of previous) {
      const parsed = ExecutorSessionRequestSchema.safeParse(request.status === 'pending'
        ? { ...request, status: 'expired', reason: 'executor_restarted' } : request)
      if (parsed.success) this.#entries.push({ request: parsed.data, settled: (this.#settled += 1) })
    }
    if (previous.some((request) => request.status === 'pending')) this.publish()
  }

  /** Whether a request may be put to the owner now; when not, a provider's prompt is turned down at once. */
  ownerReachable(): boolean { return this.reachable() }

  /**
   * Opens a request; the draft's text must already be projected and within
   * the protocol's bounds. A draft the protocol refuses, or any draft while
   * the owner cannot be reached, opens nothing and answers undefined, so the
   * caller turns the provider down instead.
   */
  open(draft: SessionRequestDraft, responder: SessionRequestResponder): ExecutorSessionRequest | undefined {
    if (!this.reachable()) return undefined
    const parsed = ExecutorSessionRequestSchema.safeParse({
      ...draft, id: `req-${randomUUID()}`, status: 'pending', answerable: draft.answerable ?? true,
      openedAt: new Date().toISOString(),
    })
    if (!parsed.success) return undefined
    this.#entries.push({ request: parsed.data, responder, settled: 0 })
    this.publish()
    return parsed.data
  }

  get(id: string): ExecutorSessionRequest | undefined {
    return this.#entries.find((entry) => entry.request.id === id)?.request
  }

  /** Settles the request with the owner's answer and hands it to the provider; a problem changes nothing. */
  answer(answer: HostAnswer, effect?: SessionEffectAuthority): AnswerProblem | undefined {
    const entry = this.#entries.find((candidate) => candidate.request.id === answer.requestId)
    const problem = answerProblem(entry?.request, answer)
    if (problem || !entry) return problem ?? 'request_not_pending'
    effect?.assertLive()
    this.settle(entry, 'answered', undefined, answer.decision)
    entry.responder?.answer(answer, effect)
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

  private settle(
    entry: Entry, status: Exclude<ExecutorSessionRequest['status'], 'pending'>, reason?: string,
    decision?: ExecutorSessionDecision,
  ): void {
    entry.request = { ...entry.request, status, ...(reason ? { reason } : {}), ...(decision ? { decision } : {}) }
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
