import { mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { CODING_EVENT_LIMITS, type Projector } from './projection.js'
import { secretAskOf, type SecretOutcome } from './session-secret-mcp.js'
import { writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import type { SessionRequestBook } from './session-request-book.js'

/**
 * The host's half of `request_secret`: each ask the agent's call leaves in
 * `secret-asks/` becomes one `secret` request, and its outcome goes back to
 * the waiting call in `secret-answers/`. The owner may supply the value or
 * turn the request down (`decline`, or `cancel`, which also stops the turn).
 * The value itself never reaches the host: the executor writes it into the
 * named file when the answer arrives, before the host hears of it.
 */
export const createSecretAskWatcher = (input: {
  paths: CodingSessionPaths
  requests: SessionRequestBook
  projector: Projector
  /** Stops the turn, for an owner who cancels rather than declines. */
  interrupt: () => void
  log: (message: string) => void
}) => {
  const { paths } = input
  const known = new Set<string>()
  const reply = async (askId: string, outcome: SecretOutcome): Promise<void> => {
    await writeJsonAtomic(join(paths.secretAnswers, `${askId}.json`), outcome)
      .catch((error: unknown) => input.log(`a secret outcome could not be written: ${String(error)}`))
    await unlink(join(paths.secretAsks, `${askId}.json`)).catch(() => undefined)
  }
  return {
    prepare: async (): Promise<void> => {
      await mkdir(paths.secretAsks, { recursive: true, mode: 0o700 })
      await mkdir(paths.secretAnswers, { recursive: true, mode: 0o700 })
    },
    /** Opens a request for every ask not seen yet. */
    poll: async (): Promise<void> => {
      const names = (await readdir(paths.secretAsks).catch(() => [] as string[]))
        .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name) && !known.has(name))
      for (const name of names) {
        known.add(name)
        const askId = name.slice(0, -'.json'.length)
        const raw = await readFile(join(paths.secretAsks, name), 'utf8').then((text) => JSON.parse(text) as unknown, () => undefined)
        // The ask is the agent's own writing: checked again here, as if the call had just been made.
        const ask = secretAskOf(raw)
        if ('refused' in ask) {
          await reply(askId, { outcome: 'refused', reason: 'invalid_request' })
          continue
        }
        const secretName = input.projector.line(ask.name, 200) || 'a secret'
        const opened = input.requests.open({
          kind: 'secret', title: input.projector.line(`Provide ${secretName}`, 300),
          justification: input.projector.text(ask.reason, CODING_EVENT_LIMITS.result),
          secretName, destination: ask.destination, ...(ask.envName ? { envName: ask.envName } : {}),
          decisions: ['decline', 'cancel'],
        }, {
          answer: (answer) => {
            if (answer.secretSaved) {
              void reply(askId, { outcome: 'saved', destination: ask.destination })
              return
            }
            void reply(askId, { outcome: answer.decision === 'cancel' ? 'cancelled' : 'declined', reason: 'owner_declined' })
            if (answer.decision === 'cancel') input.interrupt()
          },
          withdraw: (status, reason) => { void reply(askId, { outcome: status, reason }) },
        })
        if (!opened) {
          await reply(askId, { outcome: 'refused',
            reason: input.requests.ownerReachable() ? 'invalid_request' : 'owner_unreachable' })
        }
      }
    },
  }
}
