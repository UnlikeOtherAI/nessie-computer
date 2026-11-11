import { join } from 'node:path'
import { canonicalExecutorJson, type ExecutorChatgptContext } from '@nessie/executor-protocol'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'
import { createLocalInferenceDaemonApi } from './local-inference-api.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'
import { startLocalInferenceHostSession } from './local-inference-host-session.js'
import { EncryptedLocalInferenceReceiptJournal } from './local-inference-receipts.js'
import { ChatgptReceiptCustody } from './chatgpt-receipt-custody.js'
import { createChatgptBackend } from './chatgpt-backend.js'
import { createProfileChatgptAuthProvider } from './chatgpt-profile-auth-provider.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { chatgptProfileSource, type ChatgptProfileRecord } from './chatgpt-profile-records.js'
import type { ChatgptProfileKey } from './chatgpt-profile-key.js'
import type { ManagedChatgptCredentialRuntime } from './chatgpt-managed-runtime.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import type { ChatgptOAuthProvider } from './chatgpt-oauth-provider.js'
import { reconcileStoppedChatgptReceipts } from './chatgpt-profile-outbox.js'
import { readChatgptBackgroundConsent } from './chatgpt-background-consent.js'
import { watchInferenceUpdateDrain } from './updates/inference-drain.js'

const fail = (): never => { throw new PersonalInferenceProtectionError('chatgpt_host_authority_unavailable') }

/** Same queue/socket/attempt protocol, with a distinct cloud resource and user key. */
export const runProfileChatgptHost = async (input: {
  runtime: ManagedChatgptCredentialRuntime; profile: ChatgptProfileRecord; key: ChatgptProfileKey
  renewAuthority: () => Promise<ExecutorChatgptContext>; signal: AbortSignal
  oauth?: Pick<ChatgptOAuthProvider, 'refresh'>
  backendOptions?: Parameters<typeof createChatgptBackend>[1]
}): Promise<string | undefined> => {
  const context = await input.renewAuthority()
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: context.principal.serverOrigin })
  const challenge = await api.issueChallenge({ hostId: context.hostId })
  const body = { challenge: challenge.challenge }
  const claim = await api.claim({ challenge: challenge.challenge, envelope: signLocalInferenceEnvelope({ body,
    machinePrivateKey: input.key.privateKey, header: {
      protocolVersion: 1, purpose: 'claim', hostId: context.hostId,
      organizationId: context.principal.organizationId, connectionEpoch: context.hostConnectionEpoch,
      executorConnectionEpoch: context.connectionEpoch, sentAt: new Date().toISOString(), sequence: 1,
    } }) })
  const claimed = await input.renewAuthority()
  if (claimed.hostId !== context.hostId || claimed.hostConnectionEpoch !== claim.connectionEpoch
    || claimed.connectionEpoch !== context.connectionEpoch
    || claimed.publicKeyFingerprint !== context.publicKeyFingerprint
    || canonicalExecutorJson(claimed.principal) !== canonicalExecutorJson(context.principal)) return fail()
  const source = chatgptProfileSource(input.profile)
  const directory = join(input.runtime.mutation.root, 'cloud-capacity', source.profileId,
    String(source.accountGeneration), String(source.consentRevision))
  await input.runtime.mutation.ensureDirectory(directory)
  const coordinator = await LocalInferenceCoordinator.openChatgpt(source, { directory,
    cloudMutation: input.runtime.mutation.mutate, cloudBarrier: input.runtime.mutation.barrier })
  let journal!: EncryptedLocalInferenceReceiptJournal
  const custody = new ChatgptReceiptCustody({ mutation: input.runtime.mutation, context: claimed, key: input.key,
    accountGeneration: source.accountGeneration, consentRevision: source.consentRevision,
    backgroundConsentRevision: () => readChatgptBackgroundConsent(input.runtime.guard,
      { source, principal: claimed.principal }),
    canForget: async attemptId => !await journal.hasPendingAttempt(attemptId)
      && !await coordinator.hasPendingTermination(attemptId) })
  await custody.open()
  journal = new EncryptedLocalInferenceReceiptJournal(custody.storage, Buffer.from(input.key.receiptKey, 'base64url'),
    () => new Date(), { personalCapacity: 4 })
  await reconcileStoppedChatgptReceipts({ custody, journal, coordinator })
  const store = new ChatgptProfileStore()
  await input.runtime.authority.assertCurrent()
  await store.update(input.profile.profileId, prior => {
    if (!prior || prior.operationId !== input.profile.operationId || prior.phase === 'disconnecting'
      || prior.accountGeneration !== source.accountGeneration || prior.consentRevision !== source.consentRevision) {
      return fail()
    }
    return { ...prior, revision: prior.revision + 1, phase: 'ready', reason: null, planEnabled: true,
      restartAfterUpdate: undefined }
  })
  const auth = createProfileChatgptAuthProvider({ ...input, context: claimed,
    assertInvocationPrepared: attempt => custody.assertInvocationPrepared(attempt) })
  const session = startLocalInferenceHostSession({ apiBaseUrl: claimed.principal.serverOrigin,
    identity: { connectionEpoch: claim.connectionEpoch, executorConnectionEpoch: claimed.connectionEpoch,
      hostId: claimed.hostId, organizationId: claimed.principal.organizationId,
      machinePrivateKey: input.key.privateKey },
    backend: createChatgptBackend(auth, input.backendOptions), coordinator, journal,
    connectionLabel: async () => (await store.read(input.profile.profileId))?.label,
    personalReceipts: custody.transport,
    isPaused: () => input.signal.aborted, origin: 'https://api.openai.com/v1', onError: () => undefined })
  const update = watchInferenceUpdateDrain({ loop: session.loop })
  let timer: NodeJS.Timeout | undefined
  let working: Promise<void> | undefined
  let rejectRuntime!: (error: unknown) => void
  const failed = new Promise<never>((_resolve, reject) => { rejectRuntime = reject })
  const aborted = new Promise<void>(resolve => {
    if (input.signal.aborted) resolve()
    else input.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  try {
    await Promise.race([session.connected, aborted, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('chatgpt_connection_unavailable')), 10000)
    })])
    clearTimeout(timer)
    input.signal.throwIfAborted()
    await session.heartbeat()
    timer = setInterval(() => {
      working ??= (async () => {
        const live = await input.renewAuthority()
        if (live.connectionEpoch !== claimed.connectionEpoch || live.hostConnectionEpoch !== claim.connectionEpoch
          || live.publicKeyFingerprint !== claimed.publicKeyFingerprint
          || canonicalExecutorJson(live.principal) !== canonicalExecutorJson(claimed.principal)) return fail()
        if ((await store.read(input.profile.profileId))?.reason === 'refresh_uncertain') return fail()
        await session.loop.reconcileReceipts()
        await session.heartbeat()
      })().catch(rejectRuntime).finally(() => { working = undefined })
    }, 5000)
    return await Promise.race([aborted.then(() => undefined), failed, session.refused.then(fail), update.ready])
  } finally {
    update.stop()
    clearInterval(timer)
    session.loop.stop()
    await session.stop()
    await working
    // Historic HTTPS settlement uses original authority even when live work
    // is fenced. Failure leaves native receipts; never replays provider POST.
    await session.loop.reconcileReceipts().catch(() => undefined)
    await reconcileStoppedChatgptReceipts({ custody, journal, coordinator }).catch(() => undefined)
  }
}
