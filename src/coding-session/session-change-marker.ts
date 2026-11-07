import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { writeJsonAtomic } from './session-files.js'

/**
 * The one file every session host replaces when a session's status or pending
 * requests change, which the daemon watches (`session-change-watch.ts`). It
 * names the session only so a person reading the state directory can tell
 * what moved; the daemon reads nothing but the file's identity, and a
 * replacement is atomic, so two hosts writing at once still move it.
 */
export const codingSessionChangeMarker = (stateDir: string): string => join(stateDir, 'session-changes.json')

export const markCodingSessionChanged = (stateDir: string, sessionId: string): Promise<void> => (
  writeJsonAtomic(codingSessionChangeMarker(stateDir), { sessionId, at: new Date().toISOString(), nonce: randomUUID() })
    .catch(() => undefined)
)
