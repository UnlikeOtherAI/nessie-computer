import {
  canonicalExecutorJson, LocalInferenceAttemptRequestSchema, personalInferenceAuthorityDecision,
  type ExecutorChatgptContext, type LocalInferenceAttemptRequest,
} from '@nessie/executor-protocol'
import { sameChatgptSource, type ChatgptAuthProvider } from './chatgpt-auth-provider.js'
import { ChatgptCredentialStore } from './chatgpt-credential-store.js'
import { ChatgptError } from './chatgpt-errors.js'
import { ChatgptOAuthProvider, hasChatgptPlanPermission, type ChatgptTokens } from './chatgpt-oauth-provider.js'
import { chatgptProfileSource, type ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import type { ManagedChatgptCredentialRuntime } from './chatgpt-managed-runtime.js'
import { ChatgptBackgroundAccess, readChatgptBackgroundConsent } from './chatgpt-background-consent.js'

/** One retained credential child, one exact profile and claimed companion host. */
export const createProfileChatgptAuthProvider = (input: {
  runtime: ManagedChatgptCredentialRuntime
  context: ExecutorChatgptContext
  renewAuthority: () => Promise<ExecutorChatgptContext>
  signal: AbortSignal
  /** Native original-origin stage must commit after durable accept and before access is leased. */
  assertInvocationPrepared?: (attempt: LocalInferenceAttemptRequest) => Promise<void>
  oauth?: Pick<ChatgptOAuthProvider, 'refresh'>
  /** Deterministic fixtures only; production constructs the protected stores below. */
  stores?: { profiles: Pick<ChatgptProfileStore, 'read' | 'update'>
    credentials: Pick<ChatgptCredentialStore, 'load' | 'refresh'> }
}): ChatgptAuthProvider => {
  const profile = input.runtime.profile
  const source = chatgptProfileSource(profile)
  const store = input.stores?.profiles ?? new ChatgptProfileStore()
  const credentials = input.stores?.credentials ?? new ChatgptCredentialStore({ ...source,
    mutation: input.runtime.mutation, authority: input.runtime.authority })
  const oauth = input.oauth ?? new ChatgptOAuthProvider()
  let renewing: Promise<ChatgptTokens> | undefined
  const backgroundRevision = () => readChatgptBackgroundConsent(input.runtime.guard,
    { source, principal: input.context.principal })
  const backgroundAccess = new ChatgptBackgroundAccess(backgroundRevision, input.signal)
  const current = async (): Promise<ChatgptProfileRecord> => {
    input.signal.throwIfAborted()
    await input.runtime.authority.assertCurrent()
    const record = await store.read(profile.profileId)
    if (!record || record.phase !== 'ready' || !record.planEnabled || !record.registration.clientId
      || !sameChatgptSource(source, chatgptProfileSource(record))) {
      throw new ChatgptError('chatgpt_needs_sign_in', 'not_sent')
    }
    return record
  }
  return {
    backgroundConsentRevision: async candidate => {
      await current()
      return sameChatgptSource(candidate, source) ? backgroundRevision() : null
    },
    listReadyProfiles: async () => {
      try { await current(); return [source] } catch { return [] }
    },
    acquireAccess: async (request) => {
      request.signal.throwIfAborted()
      if (!sameChatgptSource(request.source, source)) throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
      const record = await current()
      let backgroundConsentRevision: number | null = null
      const context = await input.renewAuthority()
      if (context.profileId !== source.profileId || context.executorId !== input.context.executorId
        || context.connectionEpoch !== input.context.connectionEpoch || context.hostId !== input.context.hostId
        || context.hostConnectionEpoch !== input.context.hostConnectionEpoch
        || context.publicKeyFingerprint !== input.context.publicKeyFingerprint
        || canonicalExecutorJson(context.principal) !== canonicalExecutorJson(input.context.principal)) {
        throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
      }
      if (request.purpose === 'inference') {
        const attempt = LocalInferenceAttemptRequestSchema.parse(request.attempt)
        if (attempt.personalAuthority?.origin.kind === 'background') {
          backgroundConsentRevision = await backgroundRevision()
        }
        const decision = personalInferenceAuthorityDecision(attempt.personalAuthority, context.principal,
          backgroundConsentRevision)
        if (!decision.allowed || attempt.hostId !== context.hostId
          || attempt.hostEpoch !== Number(context.hostConnectionEpoch)
          || attempt.personalAuthority?.runId !== attempt.runId
          || attempt.inferenceSource?.kind !== 'chatgpt' || !sameChatgptSource(source, attempt.inferenceSource)) {
          throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
        }
        if (input.assertInvocationPrepared) await input.assertInvocationPrepared(attempt)
        else if (!input.stores) throw new ChatgptError('chatgpt_unavailable', 'not_sent')
      }
      const leaseController = new AbortController()
      const signal = AbortSignal.any([request.signal, input.signal, leaseController.signal])
      const forget = backgroundConsentRevision === null ? () => undefined
        : backgroundAccess.retain(leaseController, backgroundConsentRevision)
      renewing ??= (async () => {
        let tokens = await credentials.load()
        if (!tokens.expiresAt || tokens.expiresAt <= Date.now() + 30_000) {
          try {
            // Rotation is owned by this registered runtime, not one caller's
            // cancellation. Concurrent local callers await the same grant.
            tokens = await credentials.refresh(previous =>
              oauth.refresh(record.registration.clientId!, previous, input.signal))
          } catch {
            await store.update(profile.profileId, (prior) => {
              if (!prior || prior.phase !== 'ready' || prior.credentialProcess?.pid !== profile.credentialProcess?.pid
                || !sameChatgptSource(source, chatgptProfileSource(prior))) {
                throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
              }
              return { ...prior, revision: prior.revision + 1, phase: 'reconnecting', reason: 'refresh_uncertain',
                planEnabled: false }
            })
            throw new ChatgptError('chatgpt_needs_sign_in', 'not_sent')
          }
        }
        return tokens
      })().finally(() => { renewing = undefined })
      let tokens: ChatgptTokens
      try { tokens = await renewing } catch (error) {
        forget()
        leaseController.abort()
        if (error instanceof ChatgptError) throw error
        throw new ChatgptError('chatgpt_unavailable', 'not_sent')
      }
      try {
        if (!hasChatgptPlanPermission(tokens) || !tokens.accessToken) {
          throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
        }
        await current()
        if (backgroundConsentRevision !== null && await backgroundRevision() !== backgroundConsentRevision) {
          throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
        }
        signal.throwIfAborted()
        return { accessToken: tokens.accessToken, ...(tokens.accountId ? { accountId: tokens.accountId } : {}), signal,
          release: async () => { forget(); leaseController.abort() } }
      } catch (error) {
        forget()
        leaseController.abort()
        throw error
      }
    },
  }
}
