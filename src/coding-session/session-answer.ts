import { SessionEffectRefused, type SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ExecutorSessionAnswerSchema, type ExecutorSessionActionReceipt, type ExecutorSessionAnswer,
  type ExecutorSessionRequest,
} from '@nessie/executor-protocol'

import { sealAnswer, type SealedContent } from './answer-seal.js'
import { SecretDestinationError, writeSecretToFolder } from './secret-destination.js'
import { recordSecretDestination } from './secret-redactions.js'
import { createJsonExclusive, ensurePrivateDir, readJson, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import { answerProblem, type HostAnswer } from './session-request-book.js'
import { readSessionAnswerKey, readSessionRequests } from './session-request-file.js'
import { writeRequest } from './session-requests.js'

/**
 * The owner's answer to one pending request of a managed session, as the
 * daemon hands it to the bridge (`session_user_action` → `session_answer`).
 *
 * It is checked against the request the host last wrote — pending, answerable,
 * and of the request's own shape — and then claimed in the session's
 * `answers/`, one file per request, so two answers racing for one request
 * settle it once: the second reads `request_not_pending`, and a retry of the
 * same action reads its first outcome.
 *
 * The claim is first an intent (`delivering`, naming this bridge process) and
 * becomes `delivered` only once the answer is in the host's inbox — a secret
 * in its file before that — so `accepted` is reported only for an answer that
 * reached its host. A claim whose bridge died mid-delivery is settled by the
 * next answer or replay that finds it: completed when its answer did reach
 * the inbox (or the host already acted on it), released otherwise, so the
 * owner's next answer, or the replay, delivers again rather than finding the
 * request answered by nothing while the provider waits.
 *
 * What the owner typed in secret — a secret's value, a secret question's
 * values — never enters the inbox or the claim readable: a secret's value is
 * written into its named file, and both reach the host only sealed to its
 * in-memory key (`answer-seal.ts`), so it can keep them out of every later
 * event (`secret-redactions.ts`).
 */

type Outcome = Pick<ExecutorSessionActionReceipt, 'state' | 'code'>

/** A claim from an older bridge has no stage: it was written when delivery was all but done. */
type Claim = {
  commandId: string; at: string; outcome: Outcome
  stage?: 'delivering' | 'delivered'
  /** Which bridge process is delivering it, so a later one can tell a crash from a delivery in flight. */
  life?: string; pid?: number
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,160}$/u
const NOT_PENDING: Outcome = { state: 'failed', code: 'request_not_pending' }
const IN_PROGRESS: Outcome = { state: 'outcome_unknown', code: 'answer_in_progress' }
/** This bridge process: a claim naming another one is not being delivered here. */
const BRIDGE_LIFE = randomUUID()
/** Delivering takes moments; a claim this old was left by a bridge that stopped. */
const DELIVERY_MS = 60_000

const writerGone = (claim: Claim, now = Date.now()): boolean => {
  // However it was written, a delivery this old did not finish: even this process's own failed one.
  if (!(now - Date.parse(claim.at) < DELIVERY_MS)) return true
  if (claim.life === BRIDGE_LIFE) return false
  if (typeof claim.pid !== 'number') return true
  try {
    process.kill(claim.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

const inboxHolds = (paths: CodingSessionPaths, commandId: string): Promise<boolean> => (
  stat(join(paths.inbox, `answer-${commandId}.json`)).then(() => true, () => false)
)

/** The answer's secret parts, sealed to the host, and the rest as the host's inbox may hold it. */
const handOver = (
  answer: ExecutorSessionAnswer, request: ExecutorSessionRequest, answerKey: string | undefined,
): HostAnswer | 'unsealable' => {
  const secretQuestions = new Set((request.questions ?? []).filter((question) => question.secret)
    .map((question) => question.id))
  const typed = answer.answers?.filter((entry) => secretQuestions.has(entry.questionId)) ?? []
  const { secret, answers, ...rest } = answer
  const content: SealedContent = {
    ...(secret !== undefined ? { secret } : {}), ...(typed.length ? { answers: typed } : {}),
  }
  // A secret question's values reach a host only sealed; a host too old to have a key cannot be given them.
  if (typed.length && !answerKey) return 'unsealable'
  const sealed = answerKey && (secret !== undefined || typed.length)
    ? sealAnswer(answerKey, request.id, content) : undefined
  return {
    ...rest,
    ...(answers ? { answers: answers.filter((entry) => !secretQuestions.has(entry.questionId)) } : {}),
    ...(secret !== undefined ? { secretSaved: true as const } : {}),
    ...(sealed ? { sealed } : {}),
  }
}

export const answerSessionRequest = async (input: {
  paths: CodingSessionPaths
  effect?: SessionEffectAuthority
  answer: unknown
  commandId: string
  hostLive: boolean
  /** The session's named folder, where a secret's destination is. */
  folder: () => Promise<string>
  ensureHost: () => Promise<unknown>
}): Promise<Outcome> => {
  const parsed = ExecutorSessionAnswerSchema.safeParse(input.answer)
  if (!parsed.success) return { state: 'failed', code: 'answer_shape_mismatch' }
  const answer = parsed.data
  if (!REQUEST_ID.test(answer.requestId)) return NOT_PENDING
  const { paths, commandId } = input
  const claimPath = join(paths.answers, `${answer.requestId}.json`)
  const reported = (claim: Claim): Outcome => (claim.commandId === commandId ? claim.outcome : NOT_PENDING)
  const requests = (): Promise<ExecutorSessionRequest[]> => readSessionRequests(paths, input.hostLive)

  const found = await readJson<Claim>(claimPath)
  if (found) {
    if (input.effect && found.stage === 'delivering') return IN_PROGRESS
    if (found.stage === undefined || found.stage === 'delivered') return reported(found)
    if (!writerGone(found)) return found.commandId === commandId ? IN_PROGRESS : NOT_PENDING
    // Its bridge stopped mid-delivery: complete the claim if the answer got through, else release it.
    const pending = (await requests()).find((request) => request.id === answer.requestId)?.status === 'pending'
    if (await inboxHolds(paths, found.commandId) || !pending) {
      await writeJsonAtomic(claimPath, { ...found, stage: 'delivered' })
      return reported(found)
    }
    await unlink(claimPath).catch(() => undefined)
  }

  const request = (await requests()).find((candidate) => candidate.id === answer.requestId)
  const problem = answerProblem(request, answer)
  if (problem || !request) return { state: 'failed', code: problem ?? 'request_not_pending' }
  const delivered = handOver(answer, request, await readSessionAnswerKey(paths))
  if (delivered === 'unsealable') return { state: 'failed', code: 'request_not_answerable' }
  const outcome: Outcome = { state: 'accepted', code: answer.secret === undefined ? 'answer_delivered' : 'secret_saved' }
  const intent: Claim = {
    commandId, at: new Date().toISOString(), outcome, stage: 'delivering', life: BRIDGE_LIFE, pid: process.pid,
  }
  await ensurePrivateDir(paths.answers)
  if (!await createJsonExclusive(claimPath, intent, input.effect)) {
    const racing = await readJson<Claim>(claimPath)
    return racing?.commandId === commandId ? IN_PROGRESS : NOT_PENDING
  }
  // Until the inbox holds it, nothing reached the host: on any failure the claim goes, so the owner can answer again.
  const release = (): Promise<void> => input.effect ? Promise.resolve() : unlink(claimPath).catch(() => undefined)
  if (answer.secret !== undefined) {
    try {
      const written = await writeSecretToFolder({
        effect: input.effect, folder: await input.folder(), destination: request.destination ?? '', value: answer.secret,
        ...(request.envName ? { envName: request.envName } : {}),
      })
      // Which file holds a supplied value, never the value: a restarted host reads it back to keep it redacted.
      await recordSecretDestination(paths, request.id, {
        destination: written.destination, ...(request.envName ? { envName: request.envName } : {}),
      })
    } catch (error) {
      if (input.effect) throw new SessionEffectRefused()
      await release()
      return { state: 'failed', code: error instanceof SecretDestinationError ? error.code : 'secret_destination_refused' }
    }
  }
  try {
    await writeRequest(paths, { id: `answer-${commandId}`, kind: 'answer', answer: delivered, at: new Date().toISOString() }, input.effect)
  } catch (error) {
    await release()
    throw error
  }
  await writeJsonAtomic(claimPath, { ...intent, stage: 'delivered' })
  await input.effect?.consume()
  await input.ensureHost()
  return outcome
}
