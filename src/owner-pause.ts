import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * The owner's pause of one team on this computer: `owner-pause.json` beside the
 * team's state, written only by the `pause` and `resume` commands this
 * computer's owner runs. Present means paused, from `since` until the owner
 * resumes; absent means not paused, the same reading the heartbeat's
 * `ownerPaused` field has. The daemon enforces it (`daemon.ts`), so a paused
 * team stays paused whatever an app shows, through restarts and updates.
 */
export type OwnerPause = { paused: true; since: string }

export const OWNER_PAUSE_FILE = 'owner-pause.json'

export const ownerPausePath = (stateDir: string): string => join(stateDir, OWNER_PAUSE_FILE)

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Null when the team is not paused. A file this cannot read as a pause still
 * reads as paused: the only writers are the owner's own commands, so an
 * unreadable one is damage, and the safe answer to damage is to start no work
 * until the owner resumes, which replaces it.
 */
export const readOwnerPause = async (stateDir: string): Promise<OwnerPause | null> => {
  const path = ownerPausePath(stateDir)
  let text: string
  try {
    await assertOwnerOnlyStatePath(path, 'file')
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    const since = (value as { since?: unknown } | null)?.since
    if ((value as { paused?: unknown } | null)?.paused === true && typeof since === 'string'
      && !Number.isNaN(Date.parse(since))) return { paused: true, since }
  } catch { /* read as paused below */ }
  return { paused: true, since: new Date(0).toISOString() }
}

/** Pauses (keeping the original `since` of a pause already in place) or resumes the team. */
export const setOwnerPaused = async (
  stateDir: string, paused: boolean, now: () => Date = () => new Date(),
): Promise<OwnerPause | null> => {
  await assertOwnerOnlyStatePath(stateDir, 'directory')
  if (!paused) {
    await unlink(ownerPausePath(stateDir)).catch((error: unknown) => { if (!missing(error)) throw error })
    return null
  }
  const current = await readOwnerPause(stateDir)
  if (current && current.since !== new Date(0).toISOString()) return current
  const pause: OwnerPause = { paused: true, since: now().toISOString() }
  await replaceOwnerOnlyJson(ownerPausePath(stateDir), pause)
  return pause
}
