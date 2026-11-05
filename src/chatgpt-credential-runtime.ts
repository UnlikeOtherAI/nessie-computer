import { isAbsolute, resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lstat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { z } from 'zod'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { readChatgptProfileKey } from './chatgpt-profile-key.js'
import { renewChatgptProfileAuthority } from './chatgpt-profile-authority.js'
import { activateManagedChatgptRuntime, activateManagedChatgptCustodyRuntime,
  prepareNewManagedChatgptRuntime } from './chatgpt-managed-runtime.js'
import { ChatgptCredentialStore } from './chatgpt-credential-store.js'
import { ChatgptOAuthProvider, hasChatgptPlanPermission } from './chatgpt-oauth-provider.js'
import { startChatgptLoopbackLogin } from './chatgpt-loopback-login.js'
import { openChatgptBrowser } from './chatgpt-browser.js'
import { chatgptProfileIntent, disconnectChatgptDelegation } from './chatgpt-profile-disconnect.js'
import { chatgptProfileSource } from './chatgpt-profile-records.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { runProfileChatgptHost } from './chatgpt-profile-host.js'
import { clearChatgptOutboxKeys } from './chatgpt-profile-outbox.js'
import type { createChatgptBackend } from './chatgpt-backend.js'
import { windowsServiceReference } from './chatgpt-windows-service-authority.js'

const refused = (): never => { throw new PersonalInferenceProtectionError('chatgpt_operation_fenced') }

/** Fixed compiled command: token objects never leave this registered child. */
export const runChatgptCredentialRuntime = async (args: string[], dependencies: {
  /** Code-only deterministic candidate seams. CLI/stdin/environment cannot select these. */
  oauth?: Pick<ChatgptOAuthProvider, 'authorizationUrl' | 'exchange' | 'refresh' | 'revoke'>
  browser?: typeof openChatgptBrowser
  backendOptions?: Parameters<typeof createChatgptBackend>[1]
} = {}): Promise<boolean> => {
  if (args[0] !== 'personal-chatgpt-credential') return false
  const service = args[1] === '--service-executor'
  if (args.length !== 7 || !args[2]
    || (service ? process.platform !== 'win32' : args[1] !== '--state-dir' || !isAbsolute(args[2]))
    || args[3] !== '--profile-id' || args[5] !== '--operation-id') return refused()
  const stateDirectory = service ? windowsServiceReference(args[2]) : resolve(args[2])
  const profileId = z.string().uuid().parse(args[4])
  const operationId = z.string().uuid().parse(args[6])
  const store = new ChatgptProfileStore()
  let profile = await store.read(profileId)
  if (!profile || profile.operationId !== operationId || !['linux', 'darwin', 'win32'].includes(process.platform)) return refused()
  const lease = await acquireOwnerStateLock(store.profileDirectory(profileId), 'profile-runtime.lock')
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let observing: Promise<void> | undefined
  let clearCredentials: (() => Promise<void>) | undefined
  try {
    // Recheck after the process-wide profile lease; a second CLI invocation
    // cannot borrow the first child's credential registration or token bytes.
    profile = await store.read(profileId)
    if (!profile || profile.operationId !== operationId) return refused()
    const preparation = profile.publicKey === null && profile.phase !== 'disconnecting'
      ? await prepareNewManagedChatgptRuntime(profile, stateDirectory)
      : { runtime: await activateManagedChatgptCustodyRuntime(profile), key: null }
    profile = preparation.runtime.profile
    const key = preparation.key ?? await readChatgptProfileKey(profileId).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || profile!.phase !== 'disconnecting') throw error
      return null
    })
    const intent = chatgptProfileIntent(profile)
    const renew = () => {
      if (!key) return refused()
      return renewChatgptProfileAuthority({ stateDirectory, intent, profile: profile!, key })
    }
    const runtime = profile.phase === 'disconnecting' ? preparation.runtime
      : await activateManagedChatgptRuntime(profile, await renew())
    profile = runtime.profile
    // This public acknowledgement completes the controllerâ†’actor handoff.
    // It precedes token reads/exchange and never contains OAuth material.
    process.stdout.write('{"started":true}\n')
    const credentials = new ChatgptCredentialStore({ ...chatgptProfileSource(profile),
      mutation: runtime.mutation, authority: runtime.authority })
    const oauth = dependencies.oauth ?? new ChatgptOAuthProvider()
    const observe = async (): Promise<void> => {
      const current = await store.read(profileId)
      if (!current || current.operationId !== operationId || current.accountGeneration !== profile!.accountGeneration
        || current.consentRevision !== profile!.consentRevision || current.phase === 'disconnecting'
        || current.phase === 'disconnected') stop()
    }
    timer = setInterval(() => {
      observing ??= observe().catch(stop).finally(() => { observing = undefined })
    }, 250)
    // Atomic profile publication emits a directory event. The interval is
    // recovery for lost events, not the normal disconnect fetch fence.
    watcher = watch(store.profileDirectory(profileId), () => {
      observing ??= observe().catch(stop).finally(() => { observing = undefined })
    })
    watcher.once('error', stop)
    const clear = async (): Promise<void> => {
      // Immediate local fetch fence is already set. Remote rejection or a
      // bounded revocation timeout never leaves local token bytes behind.
      await disconnectChatgptDelegation(stateDirectory, profile!).catch(() => undefined)
      await credentials.clear(tokens => tokens.refreshToken && profile!.registration.clientId
        ? oauth.revoke(profile!.registration.clientId, tokens.refreshToken, AbortSignal.timeout(3000))
        : Promise.resolve(false))
      // Exact outbox ACKs and native absence proof precede key deletion. A
      // failed/unknown delivery retains keys and the global host-tool fence.
      await clearChatgptOutboxKeys({ runtime, profile: profile!, key })
    }
    clearCredentials = clear
    if (profile.phase === 'disconnecting') { await clear(); return true }
    let tokens
    const hasCredentials = await lstat(join(store.profileDirectory(profileId), 'credentials.json'))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
    const spent = profile.registration.clientId && hasCredentials ? await credentials.clearSpent() : false
    if (profile.registration.clientId && hasCredentials && !spent) {
      tokens = await credentials.load()
    } else {
      const login = await startChatgptLoopbackLogin({ hostId: profile.registration.extAgentHostId,
        ...(profile.registration.clientId ? { clientId: profile.registration.clientId } : {}),
        ...(profile.registration.subject ? { expectedSubject: profile.registration.subject } : {}),
        signal: controller.signal }, oauth)
      try {
        await (dependencies.browser ?? openChatgptBrowser)(login.authorizationUrl)
        const result = await login.completion
        if (result.status !== 'verified') throw new Error('chatgpt_login_incomplete')
        controller.signal.throwIfAborted()
        await renew()
        // Retain the issued registration before token publication. A crash
        // between these writes must never fall back to dynamic_agent_client.
        profile = await store.update(profileId, prior => {
          if (!prior || prior.operationId !== operationId || prior.phase !== 'signing_in') return refused()
          return { ...prior, revision: prior.revision + 1,
            registration: { ...prior.registration, clientId: result.clientId, subject: result.tokens.subject } }
        })
        await credentials.save(result.tokens)
        tokens = result.tokens
      } finally { await login.cancel() }
    }
    controller.signal.throwIfAborted()
    if (!hasChatgptPlanPermission(tokens)) {
      await store.update(profileId, prior => {
        if (!prior || prior.operationId !== operationId || prior.phase === 'disconnecting') return refused()
        return { ...prior, revision: prior.revision + 1, phase: 'identity_only', reason: 'plan_permission_missing',
          planEnabled: false }
      })
    } else {
      if (!key) return refused()
      while (!controller.signal.aborted) {
        try {
          await runProfileChatgptHost({ runtime, profile, key, renewAuthority: renew, signal: controller.signal,
            oauth, backendOptions: dependencies.backendOptions })
          break
        } catch {
          const current = await store.read(profileId)
          if (controller.signal.aborted || current?.phase === 'disconnecting') break
          // Requires an explicit new code grant, never a refresh retry.
          if (current?.reason === 'refresh_uncertain') break
          await store.update(profileId, prior => {
            if (!prior || prior.operationId !== operationId || prior.phase === 'disconnecting') return refused()
            return { ...prior, revision: prior.revision + 1, phase: 'reconnecting',
              reason: 'connection_unavailable', planEnabled: false }
          })
          await delay(3000, undefined, { signal: controller.signal }).catch(() => undefined)
        }
      }
    }
    const current = await store.read(profileId)
    if (current?.phase === 'disconnecting') await clear()
  } catch {
    if ((await store.read(profileId))?.phase === 'disconnecting') await clearCredentials?.().catch(() => undefined)
    // Public metadata contains only an enumerated reason. No provider/portal
    // error, URL, state, code, token or JWT payload reaches stdout/stderr.
    await store.update(profileId, prior => {
      if (!prior || prior.operationId !== operationId || prior.phase === 'disconnecting') return refused()
      return { ...prior, revision: prior.revision + 1, phase: 'reconnecting', reason: 'connection_unavailable',
        planEnabled: false }
    }).catch(() => undefined)
  } finally {
    clearInterval(timer)
    watcher?.close()
    stop()
    await observing
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    await lease.release()
  }
  return true
}
