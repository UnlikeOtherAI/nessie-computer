import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { PersonalChatgptConsoleOperationSchema, PersonalChatgptConsoleStatusSchema, type PersonalChatgptConnectIntent,
  type PersonalChatgptProfileStatus } from '@nessie/executor-protocol'
import { CHATGPT_ISSUER } from './chatgpt-oauth-provider.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { ChatgptProfileRecordSchema, publicChatgptProfileStatus } from './chatgpt-profile-records.js'
import { finalizeChatgptDisconnect } from './chatgpt-profile-disconnect.js'
import { matchingChatgptPairing } from './chatgpt-profile-authority.js'
import { withManagedRuntimeInventory } from './managed-runtime-inventory.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { launchChatgptCredential } from './chatgpt-credential-launch.js'
import { resumeChatgptAfterUpdate } from './updates/chatgpt-resume.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import type { ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { profileBackgroundConsent, setChatgptBackgroundConsent } from './chatgpt-background-consent.js'
import { resolveChatgptLocalOperation } from './chatgpt-local-operation.js'
import { windowsServiceReference } from './chatgpt-windows-service-authority.js'

type Operation = ReturnType<typeof PersonalChatgptConsoleOperationSchema.parse>
const usage = (): never => {
  throw new Error('Usage: nessie-executor personal-chatgpt --operation-stdin --state-dir <path>')
}
const unsupported = (): PersonalChatgptProfileStatus['reason'] => process.platform === 'win32'
  ? 'service_barrier_unavailable' : 'native_context_unsupported'
const publicFailure = (error: unknown): NonNullable<PersonalChatgptProfileStatus['reason']> => {
  if (!(error instanceof PersonalInferenceProtectionError)) return 'connection_unavailable'
  if (['personal_inference_incompatible_sessions', 'personal_inference_host_isolation_required'].includes(error.code)) {
    return 'host_sessions_active'
  }
  if (error.code === 'chatgpt_owner_authority_unavailable') return 'owner_authority_unavailable'
  if (error.code === 'chatgpt_registration_scope_ambiguous') return 'account_replacement_requires_consent'
  return 'runtime_inventory_unknown'
}
const readOperation = async (stateDirectory: string, local: boolean): Promise<Operation> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > 16 * 1024) usage()
    chunks.push(bytes)
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return local ? resolveChatgptLocalOperation(stateDirectory, input)
    : PersonalChatgptConsoleOperationSchema.parse(input)
}

const preflight = async (stateDirectory: string, intent: PersonalChatgptConnectIntent): Promise<void> => {
  await matchingChatgptPairing(stateDirectory, intent)
  await withManagedRuntimeInventory(async () => {
    const status = await PersonalInferenceGuard.open().status()
    if (status.registrations.some(item => item.kind === 'host_execution')) {
      throw new PersonalInferenceProtectionError('personal_inference_incompatible_sessions')
    }
  })
}
const reconcile = async (store: ChatgptProfileStore, profile: ChatgptProfileRecord): Promise<ChatgptProfileRecord> => {
  // An update restart keeps its original operation and consent. Status may
  // resume it through the current native factory after the old actor is gone.
  if (profile.restartAfterUpdate?.operationId === profile.operationId) return profile
  if (!['ready', 'signing_in', 'reconnecting'].includes(profile.phase)) return profile
  try {
    const start = await acquireOwnerStateLock(store.profileDirectory(profile.profileId), 'profile-start.lock')
    try {
      // A live or uncertain generation keeps the claim. Successful acquisition
      // proves the old actor cannot publish after this operation fence changes.
      const lease = await acquireOwnerStateLock(store.profileDirectory(profile.profileId), 'profile-runtime.lock')
      try {
        return await store.update(profile.profileId, prior => {
          if (!prior || prior.revision !== profile.revision) throw new Error('profile_changed')
          return { ...prior, revision: prior.revision + 1,
            phase: prior.registration.clientId ? 'reconnecting' : 'disconnecting',
            reason: 'connection_unavailable', planEnabled: false,
            operationId: prior.registration.clientId ? null : randomUUID() }
        })
      } finally { await lease.release() }
    } finally { await start.release() }
  } catch { return await store.read(profile.profileId) ?? profile }
}

/** Local public control only; OAuth URLs, codes, identities and tokens never use this channel. */
export const runPersonalChatgptCli = async (args: string[]): Promise<boolean> => {
  if (!['personal-chatgpt', 'personal-chatgpt-local'].includes(args[0] ?? '')) return false
  if (args.length !== 4 || args[1] !== '--operation-stdin' || !args[3]) usage()
  const service = args[2] === '--service-executor'
  if (service ? process.platform !== 'win32' : args[2] !== '--state-dir' || !isAbsolute(args[3]!)) usage()
  const stateDirectory = service ? windowsServiceReference(args[3]!) : resolve(args[3]!)
  const operation = await readOperation(stateDirectory, args[0] === 'personal-chatgpt-local')
  const store = new ChatgptProfileStore()
  let profiles: PersonalChatgptProfileStatus[] = []
  let reason: PersonalChatgptProfileStatus['reason'] = null
  let stopped: Promise<void> | undefined
  const owners = new Set<Promise<void>>()
  const retainOwner = (owned: Promise<void>): void => { stopped = owned; owners.add(owned) }
  let starting: Awaited<ReturnType<typeof acquireOwnerStateLock>> | undefined
  const publish = (): void => {
    process.stdout.write(`${JSON.stringify(PersonalChatgptConsoleStatusSchema.parse({ version: 1, profiles, reason,
      restriction: 'unisolated_terminal_coding_and_custom_stdio_blocked' }))}\n`)
  }
  try {
    if (operation.operation === 'cancel') {
      const profile = await store.operation(operation.operationId)
      if (profile && profile.phase !== 'disconnected') {
        await matchingChatgptPairing(stateDirectory, { version: 1, kind: 'personal-chatgpt-connect',
          apiOrigin: profile.apiOrigin, executorId: profile.executorId,
          organizationId: profile.organizationId, teamId: profile.teamId, profileId: profile.profileId })
        const next = await store.update(profile.profileId, prior => {
          if (!prior || prior.operationId !== operation.operationId) {
            throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
          }
          return { ...prior, revision: prior.revision + 1, phase: 'disconnecting', planEnabled: false }
        })
        profiles = [publicChatgptProfileStatus(next)]
        if (['linux', 'darwin', 'win32'].includes(process.platform)) {
          try {
            ({ stopped } = await launchChatgptCredential(
              stateDirectory, next.profileId, next.operationId!, retainOwner,
            ))
          }
          catch { /* The existing actor observes the public fence; unknown custody remains protected. */ }
        }
      }
    } else {
      await matchingChatgptPairing(stateDirectory, operation.intent)
      if (operation.operation === 'start' && operation.acknowledgeHostRestriction === true
        && ['linux', 'darwin', 'win32'].includes(process.platform)) {
        await preflight(stateDirectory, operation.intent)
        await PersonalInferenceGuard.open().initialize()
        // One console/start handoff across pairings. Reload selected scope
        // while held so concurrent CLI/desktop starts cannot create two logins.
        starting = await acquireOwnerStateLock(store.directory, 'profile-start.lock')
        // A concurrent removal may have completed while this controller waited.
        // Never create even public login state from a retired pairing.
        await matchingChatgptPairing(stateDirectory, operation.intent)
      }
      const scoped = await store.scoped(operation.intent)
      if (operation.intent.profileId && scoped.length !== 1) {
        throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
      }
      if (operation.operation === 'status') {
        for (const original of scoped) {
          await resumeChatgptAfterUpdate({ stateDirectory, store, profile: original, retainOwner })
            .catch(() => undefined)
          const profile = await reconcile(store, original)
          if (profile.phase === 'disconnecting' && ['linux', 'darwin', 'win32'].includes(process.platform)) {
            // Kernel generation proof inside the guard refuses live/unknown
            // credential owners; absence of a token file alone cannot unlock.
            await finalizeChatgptDisconnect(stateDirectory, profile).catch(() => undefined)
            const stillDisconnecting = await store.read(profile.profileId)
            if (stillDisconnecting?.phase === 'disconnecting' && stillDisconnecting.operationId) {
              try {
                ({ stopped } = await launchChatgptCredential(stateDirectory, profile.profileId,
                  stillDisconnecting.operationId, retainOwner))
              } catch { /* A live credential owner remains responsible for cleanup. */ }
            }
          }
          const current = await store.read(profile.profileId)
          if (current) profiles.push(publicChatgptProfileStatus(current))
        }
        if (!['linux', 'darwin', 'win32'].includes(process.platform)) reason = unsupported()
        else await preflight(stateDirectory, operation.intent)
      } else if (operation.operation === 'background-consent') {
        await setChatgptBackgroundConsent(stateDirectory, operation.intent,
          operation.enabled, operation.expectedRevision)
        const profile = await store.read(operation.intent.profileId)
        if (profile) profiles = [publicChatgptProfileStatus(profile)]
      } else if (operation.operation === 'disconnect') {
        const profile = scoped.find(item => item.profileId === operation.intent.profileId)
        if (!profile) throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
        const next = await store.update(profile.profileId, prior => {
          if (!prior) throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
          return { ...prior, revision: prior.revision + 1, phase: 'disconnecting', planEnabled: false,
            operationId: prior.operationId ?? randomUUID() }
        })
        profiles = [publicChatgptProfileStatus(next)]
        // A running credential owner observes this fence and clears locally.
        // Restart recovery uses a new registered child rather than controller token reads.
        try {
          ({ stopped } = await launchChatgptCredential(stateDirectory, next.profileId, next.operationId!, retainOwner))
        }
        catch { /* A live actor already owns this profile and observes the disconnect fence. */ }
      } else {
        if (operation.acknowledgeHostRestriction !== true) reason = 'host_restriction_acknowledgement_required'
        else if (!['linux', 'darwin', 'win32'].includes(process.platform)) reason = unsupported()
        else {
          const active = operation.intent.profileId ? scoped[0]
            : scoped.find(item => item.phase !== 'disconnected' && item.phase !== 'unavailable')
          const existing = active ? await reconcile(store, active) : undefined
          if (existing?.operationId && !['disconnected', 'unavailable'].includes(existing.phase)) {
            profiles = [publicChatgptProfileStatus(existing)]
            if (existing.phase === 'disconnecting') {
              await finalizeChatgptDisconnect(stateDirectory, existing).catch(() => undefined)
              const remaining = await store.read(existing.profileId)
              if (remaining?.phase === 'disconnecting') {
                try {
                  await launchChatgptCredential(stateDirectory, existing.profileId, existing.operationId, retainOwner)
                } catch { /* Retained ownership and public status keep unknown cleanup recoverable. */ }
              }
            }
          } else {
            if (existing?.phase === 'disconnected' && existing.registration.clientId) {
              throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
            }
            const profileId = existing?.profileId ?? randomUUID()
            const registrations = scoped.filter(item => item.registration.clientId)
            if (new Set(registrations.map(item => JSON.stringify(item.registration))).size > 1) {
              throw new PersonalInferenceProtectionError('chatgpt_registration_scope_ambiguous')
            }
            const extAgentHostId = await store.hostId()
            await store.update(profileId, prior => prior ? { ...prior, revision: prior.revision + 1 }
              : ChatgptProfileRecordSchema.parse({ format: 1, revision: 0, profileId,
                apiOrigin: operation.intent.apiOrigin, executorId: operation.intent.executorId,
                organizationId: operation.intent.organizationId, teamId: operation.intent.teamId,
                phase: 'disconnected', reason: null, planEnabled: false, hostExecutionRestricted: false,
                operationId: null, principal: null, accountGeneration: 1, consentRevision: 1,
                publicKey: null, credentialProcess: null, registration: { clientId: null, extAgentHostId,
                  issuer: CHATGPT_ISSUER, subject: null } }))
            const starting = await acquireOwnerStateLock(store.profileDirectory(profileId), 'profile-start.lock')
            try {
              const next = await store.update(profileId, prior => ChatgptProfileRecordSchema.parse({
                apiOrigin: operation.intent.apiOrigin, executorId: operation.intent.executorId,
                organizationId: operation.intent.organizationId, teamId: operation.intent.teamId,
                format: 1, revision: (prior?.revision ?? -1) + 1, profileId, phase: 'signing_in', reason: null,
                planEnabled: false, hostExecutionRestricted: prior?.hostExecutionRestricted ?? false,
                operationId: randomUUID(), principal: prior?.principal ?? null,
                accountGeneration: prior?.accountGeneration ?? 1, consentRevision: prior?.consentRevision ?? 1,
                publicKey: prior?.publicKey ?? null, credentialProcess: prior?.credentialProcess ?? null,
                registration: prior?.registration.clientId ? prior.registration
                  : registrations[0]?.registration
                    ?? { clientId: null, extAgentHostId, issuer: CHATGPT_ISSUER, subject: null },
              }))
              profiles = [publicChatgptProfileStatus(next)]
              const launched = await launchChatgptCredential(
                stateDirectory, next.profileId, next.operationId!, retainOwner,
              )
              stopped = launched.stopped
            } finally { await starting.release() }
          }
        }
      }
    }
  } catch (error) { reason = publicFailure(error) }
  finally { await starting?.release() }
  profiles = await Promise.all(profiles.map(async status => {
    const current = await store.read(status.profileId)
    return current ? { ...publicChatgptProfileStatus(current),
      backgroundConsentRevision: await profileBackgroundConsent(PersonalInferenceGuard.open(), current) } : status
  }))
  publish()
  if (stopped) {
    // A start is deliberately foreground on Linux. The actor's tokens and
    // historical keys are no longer in a living process before this public
    // controller attempts final clearance. Unknown remote outboxes retain it.
    await Promise.all(owners)
    for (const status of profiles) {
      const current = await store.read(status.profileId)
      if (current?.phase === 'disconnecting') {
        await finalizeChatgptDisconnect(stateDirectory, current).catch(() => undefined)
      }
    }
    profiles = await Promise.all(profiles.map(async status => {
      const current = await store.read(status.profileId)
      return current ? publicChatgptProfileStatus(current) : status
    }))
    publish()
  }
  return true
}
