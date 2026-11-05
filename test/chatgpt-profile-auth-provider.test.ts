import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ExecutorChatgptContext } from '@nessie/executor-protocol'
import { createProfileChatgptAuthProvider } from '../src/chatgpt-profile-auth-provider.js'
import { ChatgptProfileRecordSchema, chatgptProfileSource,
  type ChatgptProfileRecord } from '../src/chatgpt-profile-records.js'
import { CHATGPT_ISSUER, hasChatgptPlanPermission, type ChatgptTokens } from '../src/chatgpt-oauth-provider.js'
import type { ManagedChatgptCredentialRuntime } from '../src/chatgpt-managed-runtime.js'
import { PersonalInferenceGuard } from '../src/personal-inference-guard.js'
import { attempt } from './fixtures/local-inference-host.js'

const fixture = () => {
  const principal = { serverOrigin: 'https://nessie.example', identityIssuer: 'https://nessie.example',
    organizationId: randomUUID(), teamId: randomUUID(), ownerUserId: randomUUID(), ownerSubject: 'local:fixture' }
  let profile = ChatgptProfileRecordSchema.parse({ format: 1, revision: 0, profileId: randomUUID(),
    apiOrigin: principal.serverOrigin, executorId: randomUUID(), organizationId: principal.organizationId,
    teamId: principal.teamId, phase: 'ready', reason: null, planEnabled: true, hostExecutionRestricted: true,
    operationId: null, principal, publicKey: 'p'.repeat(64), accountGeneration: 1, consentRevision: 1,
    credentialProcess: { pid: process.pid, startedAt: '123', bootId: randomUUID() },
    registration: { clientId: 'issued-nessie-fixture', extAgentHostId: randomUUID(), subject: 'openai-fixture',
      issuer: CHATGPT_ISSUER } })
  let context: ExecutorChatgptContext = { protocolVersion: 1, nonce: 'n'.repeat(48),
    executorId: profile.executorId, hostId: randomUUID(), hostConnectionEpoch: '3', delegationId: randomUUID(),
    profileId: profile.profileId, role: 'chatgpt', publicKeyFingerprint: `sha256:${'a'.repeat(64)}`,
    connectionEpoch: '2', principal, deployment: 'selfHosted', observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString() }
  const source = chatgptProfileSource(profile)
  const controller = new AbortController()
  let reads = 0
  let backgroundRevision: number | null = null
  let refreshes = 0
  let tokens: ChatgptTokens = { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    expiresAt: Date.now() + 600000, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
    subject: 'openai-fixture', issuer: CHATGPT_ISSUER }
  let refresh: (previous: ChatgptTokens) => Promise<ChatgptTokens> = async previous => previous
  const runtime: ManagedChatgptCredentialRuntime = {
    profile, guard: { status: async () => ({ version: 1, revision: 1, registrations: [],
      protection: { profiles: [{ profileId: profile.profileId, principal, inferenceSource: source,
        backgroundConsentRevision: backgroundRevision }] } }) } as unknown as PersonalInferenceGuard,
    authority: { assertCurrent: async () => undefined },
    mutation: { root: 'fixture-only', durability: 'process_crash', ensureDirectory: async () => undefined,
      barrier: async () => undefined, mutate: async () => { throw new Error('No fixture credential writes') } },
  }
  const provider = createProfileChatgptAuthProvider({ runtime, context, signal: controller.signal,
    renewAuthority: async () => context, oauth: { refresh: (_clientId, previous) => refresh(previous) },
    stores: { profiles: { read: async () => profile,
      update: async (_id, change) => { profile = change(profile); return profile } },
    credentials: { load: async () => { reads += 1; return tokens }, refresh: async exchange => {
      refreshes += 1; tokens = await exchange(tokens); return tokens
    } } } })
  const acquire = (signal = new AbortController().signal) => provider.acquireAccess({ purpose: 'discovery', source, signal })
  const inference = (background: boolean, revision = 7) => {
    const value = attempt(), runId = value.runId
    return provider.acquireAccess({ purpose: 'inference', source, signal: controller.signal, attempt: {
      ...value, hostId: context.hostId, hostEpoch: Number(context.hostConnectionEpoch), inferenceSource: source,
      numCtx: 1_050_000, maxOutputTokens: 128_000,
      personalAuthority: { principal, runId, rootRunId: runId, soleReaderUserId: principal.ownerUserId,
        agent: { kind: 'private', id: randomUUID(), ownerUserId: principal.ownerUserId, teamId: principal.teamId },
        origin: background ? { kind: 'background', authorizingUserId: principal.ownerUserId,
          automationId: randomUUID(), authorizationRevision: 1, rootRunId: runId, backgroundConsentRevision: revision }
          : { kind: 'interactive', requestingUserId: principal.ownerUserId, rootRunId: runId } },
    } })
  }
  return { provider, acquire, source, controller, reads: () => reads, refreshes: () => refreshes,
    inference, background: (revision: number | null) => { backgroundRevision = revision },
    changeContext: () => { context = { ...context, connectionEpoch: '4' } },
    phase: () => profile.phase, changeProfile: (change: Partial<ChatgptProfileRecord>) => {
      profile = { ...profile, ...change }
    }, expire: () => { tokens = { ...tokens, expiresAt: 1 } },
    refresh: (callback: typeof refresh) => { refresh = callback } }
}

test('background access needs live local consent and withdrawal aborts only the background lease', async () => {
  const f = fixture()
  await assert.rejects(f.inference(true), /policy_denied/u)
  assert.equal(f.reads(), 0)
  f.background(7)
  assert.equal(await f.provider.backgroundConsentRevision?.(f.source), 7)
  const background = await f.inference(true), foreground = await f.inference(false)
  const aborted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local withdrawal did not abort background access')), 2_000)
    background.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  f.background(null)
  await aborted
  assert.equal(foreground.signal.aborted, false)
  f.background(8)
  await assert.rejects(f.inference(true, 7), /policy_denied/u)
  const replacement = await f.inference(true, 8)
  await replacement.release()
  await background.release()
  await foreground.release()
  f.controller.abort()
})

test('an exact ready profile leases process-local access and release aborts its fetch signal', async () => {
  const f = fixture()
  assert.deepEqual(await f.provider.listReadyProfiles(), [f.source])
  const lease = await f.acquire()
  assert.equal(lease.accessToken, 'fixture-access')
  assert.equal(lease.signal.aborted, false)
  await lease.release()
  assert.equal(lease.signal.aborted, true)
  assert.equal((await f.provider.listReadyProfiles()).length, 1)
})

test('foreign source or changed parent authority is refused before any credential read', async () => {
  const f = fixture()
  await assert.rejects(f.provider.acquireAccess({ purpose: 'discovery', source: { ...f.source, consentRevision: 2 },
    signal: new AbortController().signal }), /policy_denied/u)
  f.changeContext()
  await assert.rejects(f.acquire(), /policy_denied/u)
  assert.equal(f.reads(), 0)
})

test('concurrent callers share one refresh while caller cancellation does not retry the rotating grant', async () => {
  const f = fixture()
  f.expire()
  let ready!: () => void
  let resume!: () => void
  const entered = new Promise<void>(resolve => { ready = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  f.refresh(async previous => { ready(); await held; return { ...previous,
    accessToken: 'replacement-access', refreshToken: 'replacement-refresh', expiresAt: Date.now() + 600000 } })
  const caller = new AbortController()
  const first = f.acquire(caller.signal)
  // Attach rejection before cancelling, so Node never sees an unhandled rejection.
  const cancelled = assert.rejects(first, /abort/iu)
  await entered
  const second = f.acquire()
  caller.abort()
  resume()
  await cancelled
  const lease = await second
  assert.equal(f.refreshes(), 1)
  assert.equal(lease.accessToken, 'replacement-access')
  f.controller.abort()
  assert.equal(lease.signal.aborted, true)
})

test('disconnect during a failed refresh cannot be overwritten by reconnecting metadata', async () => {
  const f = fixture()
  f.expire()
  f.refresh(async () => { f.changeProfile({ phase: 'disconnecting', planEnabled: false }); throw new Error('ambiguous') })
  await assert.rejects(f.acquire(), /policy_denied/u)
  assert.equal(f.phase(), 'disconnecting')
  assert.deepEqual(await f.provider.listReadyProfiles(), [])
})

test('a local disconnect after token load fences the lease instead of returning usable access', async () => {
  const f = fixture()
  f.expire()
  f.refresh(async previous => { f.changeProfile({ phase: 'disconnecting', planEnabled: false }); return previous })
  await assert.rejects(f.acquire(), /needs_sign_in/u)
})

test('malformed scope metadata is unavailable rather than a plan permission or a TypeError', () => {
  const value: ChatgptTokens = { idToken: 'fixture-id', accessToken: 'fixture-access', refreshToken: null,
    expiresAt: null, issuer: CHATGPT_ISSUER, subject: 'fixture', scopes: [] }
  Object.defineProperty(value, 'scopes', { value: undefined })
  assert.equal(hasChatgptPlanPermission(value), false)
})
