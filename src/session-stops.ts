import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'

/**
 * The owner's Stop for one session, from `session stop` to the running
 * daemon. Each stop is `session-stops/<sessionId>.json` in the team's
 * owner-only state directory: the CLI writes it, the daemon acts on it and
 * keeps it until Nessie closes the session, so a daemon that restarts in
 * between still refuses that session's work and still tells Nessie. A stop
 * Nessie never closed is dropped after a day.
 */
export const SESSION_STOPS_DIRECTORY = 'session-stops'

const STOP_KEPT_MS = 24 * 60 * 60 * 1_000
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export const isSessionId = (value: string): boolean => ID.test(value)

export const sessionStopsPath = (stateDir: string): string => join(stateDir, SESSION_STOPS_DIRECTORY)

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const requestSessionStop = async (
  stateDir: string, sessionId: string, now: () => Date = () => new Date(),
): Promise<void> => {
  if (!isSessionId(sessionId)) throw new Error('A session id is a UUID.')
  await ensureOwnerOnlyStateDirectory(sessionStopsPath(stateDir))
  await replaceOwnerOnlyJson(join(sessionStopsPath(stateDir), `${sessionId}.json`), {
    sessionId, stoppedAt: now().toISOString(),
  })
}

/** The sessions the owner stopped that Nessie has not closed yet; drops stops older than a day. */
export const listSessionStops = async (
  stateDir: string, now: () => number = Date.now,
): Promise<string[]> => {
  const directory = sessionStopsPath(stateDir)
  let names: string[]
  try {
    await assertOwnerOnlyStatePath(directory, 'directory')
    names = await readdir(directory)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const ids: string[] = []
  for (const name of names) {
    const id = name.replace(/\.json$/u, '')
    if (!name.endsWith('.json') || !isSessionId(id)) continue
    const info = await stat(join(directory, name)).catch(() => undefined)
    if (!info) continue
    if (now() - info.mtimeMs > STOP_KEPT_MS) {
      await unlink(join(directory, name)).catch(() => undefined)
      continue
    }
    ids.push(id)
  }
  return ids.sort()
}

export const clearSessionStop = (stateDir: string, sessionId: string): Promise<void> => (
  isSessionId(sessionId)
    ? unlink(join(sessionStopsPath(stateDir), `${sessionId}.json`)).catch((error: unknown) => {
      if (!missing(error)) throw error
    })
    : Promise.resolve()
)
