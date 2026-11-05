import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'

/** Keep the pairing's authority reachable until its personal actors finish cleanup. */
export const acquireChatgptPairingRetirement = async (apiOrigin: string, executorId: string) => {
  const store = new ChatgptProfileStore()
  await ensureOwnerOnlyStateDirectory(store.directory)
  const lock = await acquireOwnerStateLock(store.directory, 'profile-start.lock')
  try {
    const profiles = await store.connection(apiOrigin, executorId)
    const guard = await PersonalInferenceGuard.open().status()
    const protectedProfiles = await Promise.all((guard.protection?.profiles ?? []).map(profile =>
      store.read(profile.profileId)))
    if (protectedProfiles.some(profile => !profile
      || (profile.apiOrigin === apiOrigin && profile.executorId === executorId))
      || profiles.some(profile => !['disconnected', 'unavailable'].includes(profile.phase))) {
      throw new Error('Disconnect ChatGPT in this team’s local ChatGPT controls before removing the team.')
    }
    return lock
  } catch (error) { await lock.release(); throw error }
}
