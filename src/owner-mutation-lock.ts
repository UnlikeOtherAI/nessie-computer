import { resolve } from 'node:path'

import { acquireOwnerProcessLock, OwnerProcessLockError, type OwnerProcessLockOptions } from './owner-process-lock.js'

// Only mutations whose caller has already requested release appear here.
// Retain the original release operation: it checks the file identity and token again.
const finished = new Map<string, () => Promise<void>>()

export const acquireRecoverableMutationLock = async (
  directory: string, name: string, options: OwnerProcessLockOptions,
): Promise<{ release: () => Promise<void> }> => {
  const path = resolve(directory, name)
  await finished.get(path)?.().catch(() => undefined)
  const lease = await acquireOwnerProcessLock(directory, name, options)
  let attempt: Promise<void> | undefined
  let settled = false
  const forget = () => {
    settled = true
    if (finished.get(path) === release) finished.delete(path)
  }
  const release = (): Promise<void> => {
    if (settled) return Promise.resolve()
    finished.set(path, release)
    attempt ??= lease.release().then(forget, (error: unknown) => {
      if (error instanceof OwnerProcessLockError && error.code === 'owner_process_admission_fenced') forget()
      throw error
    }).finally(() => { attempt = undefined })
    return attempt
  }
  return { release }
}
