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

type FinishedUpdate = { release: () => Promise<void>; attempt?: Promise<void> }
const finishedUpdates = new Map<string, FinishedUpdate>()

// A failed release can outlive the save and its process stays alive to send heartbeats.
// Retry only the original handle, which verifies the file and token before unlinking it.
const releaseFinishedUpdate = (path: string, update: FinishedUpdate): Promise<void> => {
  const forget = () => { if (finishedUpdates.get(path) === update) finishedUpdates.delete(path) }
  update.attempt ??= update.release().then(forget, (error: unknown) => {
    if (error instanceof OwnerProcessLockError && error.code === 'owner_process_admission_fenced') forget()
  }).finally(() => { delete update.attempt })
  return update.attempt
}

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
  const previous = finishedUpdates.get(lockPath)
  if (previous) await releaseFinishedUpdate(lockPath, previous)
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
    finishedUpdates.set(lockPath, lock)
    await releaseFinishedUpdate(lockPath, lock)
  }
}
