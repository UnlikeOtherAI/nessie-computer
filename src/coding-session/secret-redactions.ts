import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { AnswerKey } from './answer-seal.js'
import type { Projector } from './projection.js'
import { ENV_NAME_PATTERN, readSecretFromFolder, secretSpellings } from './secret-destination.js'
import { ensurePrivateDir, readJson, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import type { HostAnswer } from './session-request-book.js'

/**
 * A value the owner supplied stays `<secret>` in everything the session says
 * afterwards. An agent that was given a key can still print it (`cat
 * .env.local`), and tool output reaches the conversation that people the
 * session is shared with read, so every supplied value joins the session
 * projector's redactions before the agent hears it was saved, and so does
 * every value typed into a question marked secret.
 *
 * Across a host restart the projector starts empty, and no second copy of a
 * value is kept anywhere to refill it: the session keeps only which files
 * hold one (`secret-destinations/<requestId>.json`: the destination and its
 * variable name, never the value), and a starting host reads each value back
 * from its owner-only file. A value typed into a secret question is held
 * nowhere, so its redaction lasts as long as the host that received it.
 */

/** A supplied value shorter than this would garble ordinary text; a key or a password is longer. */
export const SUPPLIED_SECRET_MIN_LENGTH = 6

export type SecretDestinationRecord = { destination: string; envName?: string }

const recordsDir = (paths: CodingSessionPaths): string => join(paths.dir, 'secret-destinations')

const REQUEST_ID = /^[A-Za-z0-9_-]{1,160}$/u

/** Remembers that `destination` holds a supplied value, written by the bridge as it writes the value. */
export const recordSecretDestination = async (
  paths: CodingSessionPaths, requestId: string, record: SecretDestinationRecord,
): Promise<void> => {
  if (!REQUEST_ID.test(requestId)) throw new Error('A request id is 1 to 160 letters, digits, - or _.')
  await ensurePrivateDir(recordsDir(paths))
  await writeJsonAtomic(join(recordsDir(paths), `${requestId}.json`), {
    destination: record.destination, ...(record.envName ? { envName: record.envName } : {}),
  })
}

/** Every spelling of a supplied value the agent could print, as `<secret>` from now on. */
export const redactSupplied = (projector: Projector, values: readonly string[]): void => {
  projector.redactSecrets(values.flatMap(secretSpellings), SUPPLIED_SECRET_MIN_LENGTH)
}

/** A starting host reads each recorded value back from its file, so it stays redacted. */
export const restoreSecretRedactions = async (
  paths: CodingSessionPaths, folder: string, projector: Projector, log: (message: string) => void,
): Promise<void> => {
  const names = (await readdir(recordsDir(paths)).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  for (const name of names.slice(0, 256)) {
    const record = await readJson<SecretDestinationRecord>(join(recordsDir(paths), name))
    if (typeof record?.destination !== 'string') continue
    if (record.envName !== undefined && !(typeof record.envName === 'string' && ENV_NAME_PATTERN.test(record.envName))) continue
    const value = await readSecretFromFolder({ folder, destination: record.destination,
      ...(record.envName ? { envName: record.envName } : {}) }).catch(() => undefined)
    // A file the agent removed or replaced no longer holds what the owner gave; nothing to hide there.
    if (value === undefined) log('a supplied secret could not be read back to keep it redacted')
    else redactSupplied(projector, [value])
  }
}

/**
 * The answer as the host's book takes it: its sealed part opened with this
 * host's key, and every value typed in secret redacted before the provider
 * hears anything. Undefined when the sealed part cannot be opened here — it
 * was sealed for another host's key — which nothing can answer any more.
 */
export const unsealHostAnswer = (answer: HostAnswer, key: AnswerKey, projector: Projector): HostAnswer | undefined => {
  if (answer.sealed === undefined) return answer
  const content = key.open(answer.sealed, answer.requestId)
  const wellFormed = content && (content.secret === undefined || typeof content.secret === 'string')
    && (content.answers === undefined || (Array.isArray(content.answers) && content.answers.every((entry) => (
      typeof entry?.questionId === 'string' && Array.isArray(entry.values)
      && entry.values.every((value) => typeof value === 'string')))))
  if (!content || !wellFormed) return undefined
  const typed = [...(content.secret === undefined ? [] : [content.secret]),
    ...(content.answers ?? []).flatMap((entry) => entry.values)]
  redactSupplied(projector, typed)
  const { sealed: _sealed, ...rest } = answer
  return content.answers ? { ...rest, answers: [...(rest.answers ?? []), ...content.answers] } : rest
}
