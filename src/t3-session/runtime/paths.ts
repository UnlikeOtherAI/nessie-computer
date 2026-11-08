import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from '../../state-security.js'

export class SessionStateError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SessionStateError' }
}

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

/** Check both the lexical and physical ancestor chains, including linked worktrees' .git files. */
export const assertOutsideCheckout = async (path: string): Promise<void> => {
  if (!isAbsolute(path)) throw new SessionStateError('session_state_absolute_path_required')
  for (let current = resolve(path);;) {
    const git = await lstat(join(current, '.git')).catch(error => { if (!missing(error)) throw error; return null })
    if (git) throw new SessionStateError('session_state_inside_checkout')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * Local storage location, not admission. The root comes from the executor's
 * loaded pairing, never a session RPC. No environment ID is normalized or used
 * as a directory name. Its exact value remains in the engine/mapping records.
 */
export const resolveT3SessionStateDir = async (executorStateRoot: string, storageKey: string): Promise<string> => {
  if (!isAbsolute(executorStateRoot) || storageKey.length === 0 || Buffer.byteLength(storageKey) > 4096) {
    throw new SessionStateError('session_state_location_invalid')
  }
  await assertOutsideCheckout(executorStateRoot)
  await assertOwnerOnlyStatePath(executorStateRoot, 'directory')
  const root = await realpath(executorStateRoot)
  await assertOutsideCheckout(root)
  const key = createHash('sha256').update('nessie:t3-session-state:v1\0').update(storageKey).digest('hex')
  let current = root
  for (const name of ['t3-sessions', key]) {
    current = join(current, name)
    const prior = await lstat(current).catch(error => { if (!missing(error)) throw error; return null })
    if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) {
      throw new SessionStateError('session_state_link_refused')
    }
    await ensureOwnerOnlyStateDirectory(current)
    if (await realpath(current) !== current) throw new SessionStateError('session_state_replaced')
  }
  await assertOutsideCheckout(current)
  return current
}
