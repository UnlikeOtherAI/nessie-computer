import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { legacyLifecycleOwnerAbsent } from './lifecycle-legacy-owner.js'
import { acquireOwnerProcessLock, OwnerProcessLockError, type OwnerProcessLockOptions } from './owner-process-lock.js'

export const STATE_MUTATION_LOCK_FILE = 'executor-state-mutation.lock'

/**
 * A settings update takes moments. A lock from before process generations
 * names only a process number; one this old has outlived whatever wrote it,
 * even when that number has since been given to another program.
 */
const OLD_LOCK_ABANDONED_AFTER_MS = 10 * 60_000

/**
 * One settings update at a time for a team.
 *
 * The lock names the process generation holding it, so an update cut short by
 * a crash, a restart or an installer never blocks the next one: the next
 * update takes a dead holder's lock over. The earlier lock was a bare
 * `wx`-created file that nothing ever cleared, so one interrupted save left a
 * team unable to start ("settings are already being updated") until someone
 * deleted the file by hand.
 */
export const withStateMutationLock = async <T>(
  stateDir: string, mutate: () => Promise<T>, options: OwnerProcessLockOptions = {},
): Promise<T> => {
  const lockPath = resolve(stateDir, STATE_MUTATION_LOCK_FILE)
  let lock: Awaited<ReturnType<typeof acquireOwnerProcessLock>>
  try {
    lock = await acquireOwnerProcessLock(stateDir, STATE_MUTATION_LOCK_FILE, {
      legacyPid: true,
      legacyOwnerAbsent: async (pid, startedAt) => await legacyLifecycleOwnerAbsent(pid, startedAt)
        || await stat(lockPath).then((file) => Date.now() - file.mtimeMs > OLD_LOCK_ABANDONED_AFTER_MS, () => false),
      ...options,
    })
  } catch (error) {
    // A lock nobody can read is not proof that its holder has gone.
    if (error instanceof OwnerProcessLockError
      && ['owner_process_admission_busy', 'owner_process_admission_invalid'].includes(error.code)) {
      throw new Error('This team’s settings are already being updated. Try again when that update finishes.')
    }
    throw error
  }
  try {
    return await mutate()
  } finally {
    // The update itself is finished either way; a later one takes over a lock this process could not remove.
    await lock.release().catch(() => undefined)
  }
}
