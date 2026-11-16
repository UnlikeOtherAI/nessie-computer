import {
  acquireOwnerProcessLock, OwnerProcessLockError,
  type OwnerProcessLockOptions,
} from './owner-process-lock.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

export { createOwnerProcessInspector as createAdmissionProcessInspector } from './owner-process-lock.js'
export type { OwnerProcessIdentity as AdmissionProcessIdentity,
  OwnerProcessInspector as AdmissionProcessInspector } from './owner-process-lock.js'
export type PersonalAdmissionLockOptions = Omit<OwnerProcessLockOptions, 'legacyPid' | 'legacyOwnerAbsent'>

type LockName = 'admission.lock' | 'mutation.lock' | 'native-writer-admission.lock' | 'credential.lock'
  | 'profile-runtime.lock' | 'profile-start.lock' | 'inference-endpoints.lock'
  | 'cli-accounts.lock' | 'local-cli-engines.lock'

const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
  try { return await operation() } catch (error) {
    if (error instanceof OwnerProcessLockError) {
      throw new PersonalInferenceProtectionError(error.code.replace('owner_process_', 'personal_inference_'))
    }
    throw error
  }
}

const acquire = async (directory: string, name: LockName, options: OwnerProcessLockOptions) => {
  const lock = await protect(() => acquireOwnerProcessLock(directory, name, options))
  return { release: () => protect(lock.release) }
}

export const acquireOwnerStateLock = (
  directory: string, lockName: LockName, options: PersonalAdmissionLockOptions = {},
): Promise<{ release: () => Promise<void> }> => acquire(directory, lockName, options)

/** Only physical legacy mutation metadata may recover after positively proven absence. */
export const acquirePhysicalInferenceStateLock = (
  directory: string, options: PersonalAdmissionLockOptions = {},
): Promise<{ release: () => Promise<void> }> => acquire(directory, 'mutation.lock', { ...options, legacyPid: true })

export const acquirePersonalAdmissionLock = (
  directory: string, options: PersonalAdmissionLockOptions = {},
): Promise<{ release: () => Promise<void> }> => acquireOwnerStateLock(directory, 'admission.lock', options)
