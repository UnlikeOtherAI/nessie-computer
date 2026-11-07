import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { ExecutorSessionAnswerSchema, type ExecutorSessionActionReceipt } from '@nessie/executor-protocol'

import { SecretDestinationError, writeSecretToFolder } from './secret-destination.js'
import { createJsonExclusive, ensurePrivateDir, readJson, type CodingSessionPaths } from './session-files.js'
import { answerProblem, type HostAnswer } from './session-request-book.js'
import { readSessionRequests } from './session-request-file.js'
import { writeRequest } from './session-requests.js'

/**
 * The owner's answer to one pending request of a managed session, as the
 * daemon hands it to the bridge (`session_user_action` → `session_answer`).
 *
 * It is checked against the request the host last wrote — pending, answerable,
 * and of the request's own shape — and then claimed in the session's
 * `answers/`, one file per request, so two answers racing for one request
 * settle it once: the second reads `request_not_pending`, and a retry of the
 * same action reads its first outcome. A secret is written into its named
 * file here, before the host hears anything, so the value never enters an
 * inbox, a log or the host; the host learns only that it was saved.
 *
 * Accepted means the answer is on its way to the provider: the host checks it
 * once more as it delivers it, and a request its provider dropped meanwhile
 * shows as expired on its card.
 */

type Outcome = Pick<ExecutorSessionActionReceipt, 'state' | 'code'>
type Claim = { commandId: string; outcome: Outcome }

const REQUEST_ID = /^[A-Za-z0-9_-]{1,160}$/u

export const answerSessionRequest = async (input: {
  paths: CodingSessionPaths
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
  if (!REQUEST_ID.test(answer.requestId)) return { state: 'failed', code: 'request_not_pending' }
  const claimPath = join(input.paths.answers, `${answer.requestId}.json`)
  const claimed = async (): Promise<Outcome> => {
    const claim = await readJson<Claim>(claimPath)
    return claim?.commandId === input.commandId ? claim.outcome : { state: 'failed', code: 'request_not_pending' }
  }
  if (await readJson<Claim>(claimPath)) return claimed()
  const requests = await readSessionRequests(input.paths, input.hostLive)
  const problem = answerProblem(requests.find((request) => request.id === answer.requestId), answer)
  if (problem) return { state: 'failed', code: problem }
  const request = requests.find((candidate) => candidate.id === answer.requestId)!
  const outcome: Outcome = { state: 'accepted', code: answer.secret === undefined ? 'answer_delivered' : 'secret_saved' }
  await ensurePrivateDir(input.paths.answers)
  if (!await createJsonExclusive(claimPath, { commandId: input.commandId, at: new Date().toISOString(), outcome })) {
    return claimed()
  }
  const { secret, ...rest } = answer
  if (secret !== undefined) {
    try {
      await writeSecretToFolder({
        folder: await input.folder(), destination: request.destination ?? '', value: secret,
        ...(request.envName ? { envName: request.envName } : {}),
      })
    } catch (error) {
      // Nothing was answered: the claim goes, so the owner can try again once the cause is fixed.
      await unlink(claimPath).catch(() => undefined)
      return { state: 'failed', code: error instanceof SecretDestinationError ? error.code : 'secret_destination_refused' }
    }
  }
  const delivered: HostAnswer = { ...rest, ...(secret !== undefined ? { secretSaved: true as const } : {}) }
  await writeRequest(input.paths, {
    id: `answer-${input.commandId}`, kind: 'answer', answer: delivered, at: new Date().toISOString(),
  })
  await input.ensureHost()
  return outcome
}
