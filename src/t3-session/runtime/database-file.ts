import { lstat, open } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { assertOwnerOnlyStatePath } from '../../state-security.js'
import { SessionStateError } from './paths.js'

/** Private destination files only. Never call this for an original source. */
export async function ownDatabaseFile(path: string, mode: 'create' | 'existing' | 'create-or-open') {
  if (mode !== 'existing') {
    try { await (await open(path, 'wx', 0o600)).close() }
    catch (error) {
      if (mode === 'create' || !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = path + suffix
    const entry = await lstat(file).catch(error => {
      if (suffix && error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
    if (!entry) continue
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new SessionStateError('session_database_shape_refused')
    }
    await assertOwnerOnlyStatePath(file, 'file')
  }
  const identity = lstatSync(path, { bigint: true })
  let lost = false
  return () => {
    if (lost) throw new SessionStateError('session_database_replaced')
    try {
      const now = lstatSync(path, { bigint: true })
      if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1n
        || now.dev !== identity.dev || now.ino !== identity.ino) throw new SessionStateError('session_database_replaced')
    } catch (error) { lost = true; throw error }
  }
}
