import {
  acquireOwnerProcessLock, readOwnerProcessLock, OwnerProcessLockError, type OwnerProcessLockOptions,
} from './owner-process-lock.js'

import { legacyLifecycleOwnerAbsent } from './lifecycle-legacy-owner.js'

type LeaseName = 'daemon.pid' | 'pairing-operation.pid' | 'pairing-activation.pid'
export type ExecutorDaemonLease = { release: () => Promise<void> }

/** This local lifetime fence never grants execution or provider authority. */
export const acquireExecutorProcessLease = async (
  stateDir: string, name: LeaseName, options: OwnerProcessLockOptions = {},
): Promise<ExecutorDaemonLease> => {
  try {
    return await acquireOwnerProcessLock(stateDir, name, {
      legacyOwnerAbsent: legacyLifecycleOwnerAbsent, ...options, legacyPid: true,
    })
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
