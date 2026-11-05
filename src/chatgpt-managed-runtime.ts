import { canonicalExecutorJson, type ExecutorChatgptContext, type PersonalInferencePrincipal } from '@nessie/executor-protocol'
import { createAdmissionProcessInspector } from './personal-admission-lock.js'
import { currentKernelBootId } from './kernel-boot.js'
import { withManagedRuntimeInventory, type ManagedRuntimeInventory } from './managed-runtime-inventory.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { createPersonalStateMutation, type PersonalStateMutation } from './personal-state-mutation.js'
import { chatgptProfileSource, type ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import type { ChatgptCredentialAuthority } from './chatgpt-credential-store.js'
import { newChatgptProfileKey, readChatgptProfileKey, saveNewChatgptProfileKey } from './chatgpt-profile-key.js'
import { prepareChatgptProfilePrincipal } from './chatgpt-profile-authority.js'
import { chatgptProfileIntent } from './chatgpt-profile-disconnect.js'

const fail = (): never => { throw new PersonalInferenceProtectionError('chatgpt_credential_runtime_unverified') }
export type ManagedChatgptCredentialRuntime = {
  guard: PersonalInferenceGuard
  mutation: PersonalStateMutation
  authority: ChatgptCredentialAuthority
  profile: ChatgptProfileRecord
}

/** Production admission: no injected compatibility verifier or registry-echo default. */
export const activateManagedChatgptRuntime = async (
  profile: ChatgptProfileRecord, context: ExecutorChatgptContext,
): Promise<ManagedChatgptCredentialRuntime> => {
  if (!['linux', 'darwin', 'win32'].includes(process.platform) || context.profileId !== profile.profileId
    || context.executorId !== profile.executorId || context.principal.serverOrigin !== profile.apiOrigin
    || context.principal.organizationId !== profile.organizationId || context.principal.teamId !== profile.teamId
    || Date.parse(context.expiresAt) <= Date.now()) fail()
  return activate(profile, context.principal)
}

/** Retained custody authorizes key access/deletion only, never inference or a new token grant. */
export const activateManagedChatgptCustodyRuntime = async (
  profile: ChatgptProfileRecord,
): Promise<ManagedChatgptCredentialRuntime> => {
  if (!['linux', 'darwin', 'win32'].includes(process.platform) || profile.phase === 'disconnected' || !profile.principal) return fail()
  const status = await PersonalInferenceGuard.open().status()
  const protectedProfile = status.protection?.profiles.find(item => item.profileId === profile.profileId)
  if (!protectedProfile
    || canonicalExecutorJson(protectedProfile.principal) !== canonicalExecutorJson(profile.principal)) {
    return fail()
  }
  return activate(profile, profile.principal)
}

/** Key creation is inside the native barrier and follows durable host refusal. */
export const prepareNewManagedChatgptRuntime = async (profile: ChatgptProfileRecord, stateDirectory: string) => {
  if (!['linux', 'darwin', 'win32'].includes(process.platform) || profile.publicKey !== null || profile.phase !== 'signing_in') return fail()
  return withManagedRuntimeInventory(async inventory => {
    // The paired public key prepares a fresh owner projection without creating
    // any new secret. No work delegation is granted by that unused challenge.
    const principal = await prepareChatgptProfilePrincipal(stateDirectory, profile, chatgptProfileIntent(profile))
    let key!: ReturnType<typeof newChatgptProfileKey>
    const runtime = await admit(profile, principal, inventory, async (activated, mutation) => {
      // A crash after native key publication but before public metadata is
      // repaired inside registered custody, never by the public controller.
      const retained = await readChatgptProfileKey(profile.profileId).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      key = retained ?? newChatgptProfileKey(profile.profileId)
      if (!retained) await saveNewChatgptProfileKey(key, mutation)
      return new ChatgptProfileStore().update(profile.profileId, prior => {
        if (!prior || prior.revision !== activated.revision || prior.publicKey !== null) return fail()
        return { ...prior, revision: prior.revision + 1, publicKey: key.publicKey }
      })
    })
    return { runtime, key }
  })
}

const activate = async (
  profile: ChatgptProfileRecord, principal: PersonalInferencePrincipal,
): Promise<ManagedChatgptCredentialRuntime> => {
  return withManagedRuntimeInventory(inventory => admit(profile, principal, inventory))
}

const admit = async (profile: ChatgptProfileRecord, principal: PersonalInferencePrincipal,
  inventory: ManagedRuntimeInventory,
  protectedWrite?: (profile: ChatgptProfileRecord, mutation: PersonalStateMutation) => Promise<ChatgptProfileRecord>,
): Promise<ManagedChatgptCredentialRuntime> => {
  const store = new ChatgptProfileStore()
  const control = createAdmissionProcessInspector()
  let activated!: ChatgptProfileRecord
  const mutation = await createPersonalStateMutation()
  if (mutation.root !== store.directory) return fail()
  const guard = await (async () => {
    const own = inventory.records.find((record) => record.childPid === process.pid)
    if (!own || await currentKernelBootId() !== own.bootId) return fail()
    const admitted = PersonalInferenceGuard.open({ verifyRuntimeInventory: async (registered) => {
      for (const item of registered) {
        if (item.kind === 'host_execution') return false
        if (inventory.records.some((record) => item.pid === record.childPid
          && item.startedAt === record.childStartedAt && item.bootId === record.bootId)) continue
        // Stale v2 runtime metadata is not an active process. The independent
        // native inventory already refused old or unproven live descendants.
        if (item.bootId && item.bootId !== own.bootId) continue
        const current = await control.identify(item.pid)
        if (current ? current.startedAt === item.startedAt : control.isAlive(item.pid)) return false
      }
      return true
    } })
    await admitted.activate({ profileId: profile.profileId, principal,
      inferenceSource: chatgptProfileSource(profile), backgroundConsentRevision: null }, async () => {
      activated = await store.update(profile.profileId, (prior) => {
        if (!prior || prior.revision !== profile.revision || prior.accountGeneration !== profile.accountGeneration
          || prior.consentRevision !== profile.consentRevision || prior.publicKey !== profile.publicKey) return fail()
        return { ...prior, revision: prior.revision + 1, principal,
          hostExecutionRestricted: true,
          credentialProcess: { pid: process.pid, startedAt: own.childStartedAt, bootId: own.bootId } }
      })
      if (protectedWrite) activated = await protectedWrite(activated, mutation)
    })
    return admitted
  })()
  const authority: ChatgptCredentialAuthority = { assertCurrent: async (purpose = 'grant') => {
    const [live, custody, boot] = await Promise.all([
      store.read(profile.profileId), guard.status(), currentKernelBootId(),
    ])
    const processIdentity = activated.credentialProcess!
    const protection = custody.protection?.profiles.find((item) => item.profileId === profile.profileId)
    if (!live || live.accountGeneration !== activated.accountGeneration
      || live.consentRevision !== activated.consentRevision
      || live.credentialProcess?.pid !== processIdentity.pid
      || live.credentialProcess.startedAt !== processIdentity.startedAt || live.credentialProcess.bootId !== boot
      || boot !== processIdentity.bootId || live.phase === 'disconnected' || !protection
      || purpose === 'grant' && live.phase === 'disconnecting'
      || canonicalExecutorJson(protection.principal) !== canonicalExecutorJson(principal)
      || !custody.registrations.some((item) => item.kind === 'credential_runtime' && item.pid === process.pid
        && item.startedAt === processIdentity.startedAt && item.bootId === boot)) fail()
  } }
  return { guard, mutation, authority, profile: activated }
}
