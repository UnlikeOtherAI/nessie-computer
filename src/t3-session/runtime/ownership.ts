import { closeSync, openSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { StateDirectoryLock } from '@nessie/t3-session-source/engine'
import { assertOwnerOnlyStatePath } from '../../state-security.js'
import { assertOutsideCheckout } from './paths.js'

/**
 * Local writer ownership, not provider clearance or original human admission.
 * Never remove the lock file. Keep this handle until runtime teardown and SQL
 * closure finish, not merely until a socket disconnects or an RPC is cancelled.
 */
export const acquireSessionStateWriter = async (directory: string): Promise<StateDirectoryLock> => {
  await assertOutsideCheckout(directory)
  await assertOwnerOnlyStatePath(directory, 'directory')
  const resolved = await realpath(directory)
  await assertOutsideCheckout(resolved)
  // Native execution storage already holds this exact volume namespace. A
  // realpath drive-letter spelling must not reintroduce an alias on lock open.
  const physical = directory.startsWith('\\\\?\\Volume{') ? directory : resolved
  const lockPath = join(physical, 'server-owner.sqlite')
  try { closeSync(openSync(lockPath, 'wx', 0o600)) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  await assertOwnerOnlyStatePath(lockPath, 'file')
  return StateDirectoryLock.acquire(physical)
}
