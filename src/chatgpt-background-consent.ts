import { canonicalExecutorJson, sameExecutorInferenceSource, type PersonalChatgptConnectIntent,
  type PersonalInferencePrincipal } from '@nessie/executor-protocol'
import type { ChatgptInferenceSource } from './chatgpt-auth-provider.js'
import { matchingChatgptPairing, prepareChatgptProfilePrincipal } from './chatgpt-profile-authority.js'
import { chatgptProfileSource, type ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { withManagedRuntimeInventory } from './managed-runtime-inventory.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

export const readChatgptBackgroundConsent = async (guard: PersonalInferenceGuard, input: {
  source: ChatgptInferenceSource; principal: PersonalInferencePrincipal;
}): Promise<number | null> => {
  const state = await guard.status()
  const profile = state.protection?.profiles.find(item => item.profileId === input.source.profileId)
  return profile && sameExecutorInferenceSource(profile.inferenceSource, input.source)
    && canonicalExecutorJson(profile.principal) === canonicalExecutorJson(input.principal)
    ? profile.backgroundConsentRevision : null
}

/** Token-free local owner control; independent managed inventory remains required. */
export const setChatgptBackgroundConsent = async (stateDirectory: string, intent: PersonalChatgptConnectIntent,
  enabled: boolean, expectedRevision: number | null): Promise<void> => {
  if (!enabled) {
    // Reducing local spend permission must work offline and while the actor
    // is reconnecting. It neither reads tokens nor removes custody protection.
    await matchingChatgptPairing(stateDirectory, intent)
    const profiles = await new ChatgptProfileStore().scoped(intent)
    const profile = profiles.length === 1 ? profiles[0] : undefined
    if (!profile?.principal) throw new PersonalInferenceProtectionError('personal_inference_background_consent_fenced')
    await PersonalInferenceGuard.open().setBackgroundConsent({ profileId: profile.profileId,
      principal: profile.principal, inferenceSource: chatgptProfileSource(profile), enabled: false, expectedRevision })
    return
  }
  await withManagedRuntimeInventory(async inventory => {
    const profiles = await new ChatgptProfileStore().scoped(intent)
    const profile = profiles.length === 1 ? profiles[0] : undefined
    const owner = profile?.credentialProcess
    if (!profile || profile.phase !== 'ready' || !profile.planEnabled || !profile.principal || !owner
      || !inventory.records.some(item => item.childPid === owner.pid && item.childStartedAt === owner.startedAt
        && item.bootId === owner.bootId)) {
      throw new PersonalInferenceProtectionError('personal_inference_background_consent_fenced')
    }
    const principal = await prepareChatgptProfilePrincipal(stateDirectory, profile, intent)
    await PersonalInferenceGuard.open().setBackgroundConsent({ profileId: profile.profileId,
      principal, inferenceSource: chatgptProfileSource(profile), enabled, expectedRevision })
  })
}

export const profileBackgroundConsent = async (guard: PersonalInferenceGuard,
  profile: ChatgptProfileRecord): Promise<number | null> => profile.phase === 'ready' && profile.planEnabled
    && profile.principal ? readChatgptBackgroundConsent(guard,
      { source: chatgptProfileSource(profile), principal: profile.principal }) : null

/** Background leases alone observe local withdrawal; ordinary foreground access is unaffected. */
export class ChatgptBackgroundAccess {
  private readonly leases = new Map<AbortController, number>()
  private timer: NodeJS.Timeout | undefined
  private reading = false
  constructor(private readonly currentRevision: () => Promise<number | null>, signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      for (const controller of this.leases.keys()) controller.abort()
      this.leases.clear()
      clearInterval(this.timer)
      this.timer = undefined
    }, { once: true })
  }
  retain(controller: AbortController, revision: number): () => void {
    this.leases.set(controller, revision)
    this.timer ??= setInterval(() => { void this.reconcile() }, 250)
    this.timer.unref()
    return () => {
      this.leases.delete(controller)
      if (!this.leases.size) { clearInterval(this.timer); this.timer = undefined }
    }
  }
  private async reconcile(): Promise<void> {
    if (this.reading) return
    this.reading = true
    const original = [...this.leases.entries()]
    try {
      const current = await this.currentRevision().catch(() => null)
      for (const [controller, revision] of original) {
        if (this.leases.get(controller) === revision && current !== revision) controller.abort()
      }
    } finally { this.reading = false }
  }
}
