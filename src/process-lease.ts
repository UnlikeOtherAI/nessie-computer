import {
  acquireOwnerProcessLock, readOwnerProcessLock, OwnerProcessLockError, type OwnerProcessLockOptions,
} from './owner-process-lock.js'

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { legacyLifecycleOwnerAbsent } from './lifecycle-legacy-owner.js'

type LeaseName = 'daemon.pid' | 'pairing-operation.pid' | 'pairing-activation.pid'
export type ExecutorDaemonLease = { release: () => Promise<void> }

/** This local lifetime fence never grants execution or provider authority. */
export const acquireExecutorProcessLease = async (
  stateDir: string, name: LeaseName, options: OwnerProcessLockOptions = {},
): Promise<ExecutorDaemonLease> => {
  try {
    const lock = await acquireOwnerProcessLock(stateDir, name, {
      legacyOwnerAbsent: legacyLifecycleOwnerAbsent, ...options, legacyPid: true,
    })
    return { release: async () => {
      try { await lock.release() } catch (error) {
        // Disconnecting a team removes its folder while this lease is held. A
        // claim that is already gone has nothing left to release; one that
        // somebody replaced is still refused.
        if (error instanceof OwnerProcessLockError && error.code === 'owner_process_admission_fenced'
          && await lstat(join(stateDir, name)).then(() => false, (reason: unknown) =>
            (reason as NodeJS.ErrnoException).code === 'ENOENT')) return
        throw error
      }
    } }
  } catch (error) {
    if (error instanceof OwnerProcessLockError && error.code === 'owner_process_admission_busy') {
      throw new Error(name === 'daemon.pid' ? 'EXECUTOR_DAEMON_ALREADY_RUNNING' : 'Pairing is busy. Try again in a moment.')
    }
    throw error
  }
}

export const executorProcessLeaseState = (
  stateDir: string, name: LeaseName, options: OwnerProcessLockOptions = {},
) => readOwnerProcessLock(stateDir, name, {
  legacyOwnerAbsent: legacyLifecycleOwnerAbsent, ...options, legacyPid: true,
})
