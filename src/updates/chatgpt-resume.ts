import { acquireOwnerStateLock } from '../personal-admission-lock.js'
import { launchChatgptCredential } from '../chatgpt-credential-launch.js'
import type { ChatgptProfileRecord } from '../chatgpt-profile-records.js'
import type { ChatgptProfileStore } from '../chatgpt-profile-store.js'
import { reportedSoftwareStatus } from './native-client.js'
import { executorSoftwareVersion } from './version.js'

/** Resumes only a previously granted profile that intentionally drained for an
 * update. Native launch admission, current pairing authority and token custody
 * are checked again by the new credential actor before it reads any token.
 */
export const resumeChatgptAfterUpdate = async (input: {
  stateDirectory: string; store: ChatgptProfileStore; profile: ChatgptProfileRecord
  retainOwner: (stopped: Promise<void>) => void
}): Promise<void> => {
  const pending = input.profile.restartAfterUpdate
  if (!pending || pending.operationId !== input.profile.operationId || !input.profile.registration.clientId
    || !input.profile.principal || ['disconnecting', 'disconnected', 'unavailable'].includes(input.profile.phase)) return
  const status = await reportedSoftwareStatus()
  if (!status.canInstall || status.installedVersion !== executorSoftwareVersion()) return
  // Opting out after a completed drain can resume the same installed release.
  // During replacement only the new, verified target can restart.
  if (pending.version !== status.installedVersion && (status.draining
    || ['waiting', 'installing', 'restarting', 'downloading'].includes(status.phase))) return
  const start = await acquireOwnerStateLock(input.store.profileDirectory(input.profile.profileId), 'profile-start.lock')
  try {
    const current = await input.store.read(input.profile.profileId)
    if (!current || current.operationId !== pending.operationId
      || current.restartAfterUpdate?.operationId !== pending.operationId
      || ['disconnecting', 'disconnected', 'unavailable'].includes(current.phase)) return
    const lease = await acquireOwnerStateLock(input.store.profileDirectory(current.profileId), 'profile-runtime.lock')
    await lease.release()
    await launchChatgptCredential(input.stateDirectory, current.profileId, pending.operationId, input.retainOwner)
  } finally { await start.release() }
}
