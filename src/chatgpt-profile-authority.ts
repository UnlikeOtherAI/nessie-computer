import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import {
  canonicalExecutorJson, ExecutorChatgptContextSchema,
  ExecutorChatgptDelegationChallengeRequestSchema, ExecutorChatgptDelegationChallengeSchema,
  ExecutorChatgptDelegationConfirmSchema, samePersonalInferenceCustodian,
  type ExecutorChatgptContext, type PersonalChatgptConnectIntent,
} from '@nessie/executor-protocol'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { randomOAuthValue } from './chatgpt-oauth-provider.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { loadExecutorState, type ExecutorLocalState } from './state-store.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import type { ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { chatgptCompanionFingerprint, signChatgptCompanionProof,
  type ChatgptCompanionKey } from './chatgpt-companion-proof.js'
import { WindowsServiceChatgptAuthority, windowsServiceExecutorId,
  requireChatgptServiceAuthority, type WindowsServicePairing } from './chatgpt-windows-service-authority.js'

export { chatgptCompanionFingerprint, type ChatgptCompanionKey } from './chatgpt-companion-proof.js'

const refuse = (): never => { throw new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable') }
export type ChatgptPairingReference = ExecutorLocalState | WindowsServicePairing
export const readChatgptPairingReference = async (reference: string): Promise<ChatgptPairingReference> => {
  requireChatgptServiceAuthority(reference)
  return windowsServiceExecutorId(reference) ? new WindowsServiceChatgptAuthority(reference).read()
    : loadExecutorState(reference)
}

export const validateChatgptPairingState = (
  state: ExecutorLocalState, intent: PersonalChatgptConnectIntent,
): ExecutorLocalState => {
  if (state.executorId !== intent.executorId || new URL(state.apiBaseUrl).origin !== intent.apiOrigin
    || !state.connectionEpoch) refuse()
  return state
}
export const matchingChatgptPairing = async (
  stateDirectory: string, intent: PersonalChatgptConnectIntent,
): Promise<ChatgptPairingReference> => {
  requireChatgptServiceAuthority(stateDirectory)
  return windowsServiceExecutorId(stateDirectory) ? new WindowsServiceChatgptAuthority(stateDirectory).matching(intent)
    : validateChatgptPairingState(await loadExecutorState(stateDirectory), intent)
}

/** Pairing-code state retains raw Ed25519 bytes; delegation always uses canonical SPKI. */
export const chatgptPreparationPublicKey = (state: ExecutorLocalState): string => {
  const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8',
    key: Buffer.from(state.machinePrivateKey, 'base64url') })
  if (privateKey.asymmetricKeyType !== 'ed25519') return refuse()
  const publicBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  const supplied = Buffer.from(state.machinePublicKey, 'base64url')
  if (supplied.toString('base64url') !== state.machinePublicKey
    || !supplied.equals(publicBytes) && !supplied.equals(publicBytes.subarray(-32))) return refuse()
  return publicBytes.toString('base64url')
}

/** Fresh selected-connection scope; no new private key or work delegation. */
export const prepareChatgptPairingPrincipal = async (
  stateDirectory: string, profileId: string,
) => {
  requireChatgptServiceAuthority(stateDirectory)
  if (windowsServiceExecutorId(stateDirectory)) {
    return new WindowsServiceChatgptAuthority(stateDirectory).principal(profileId)
  }
  const state = await loadExecutorState(stateDirectory)
  if (!state.connectionEpoch) return refuse()
  const apiOrigin = new URL(state.apiBaseUrl).origin
  const publicKey = chatgptPreparationPublicKey(state)
  const request = { executorId: state.executorId, connectionEpoch: state.connectionEpoch!,
    observedAt: new Date().toISOString(), nonce: randomOAuthValue(), profileId,
    publicKey, serverOrigin: apiOrigin }
  const challenge = ExecutorChatgptDelegationChallengeSchema.parse(await executorApi.personalChatgpt(state.apiBaseUrl,
    'challenge', ExecutorChatgptDelegationChallengeRequestSchema.parse({ ...request,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.challenge', request) })))
  const { digest, ...authority } = challenge
  if (challenge.executorId !== state.executorId || challenge.profileId !== profileId
    || challenge.connectionEpoch !== state.connectionEpoch
    || challenge.principal.serverOrigin !== apiOrigin
    || challenge.publicKeyFingerprint !== `sha256:${createHash('sha256')
      .update(Buffer.from(publicKey, 'base64url')).digest('hex')}`
    || Date.parse(challenge.expiresAt) <= Date.now() || Date.parse(challenge.expiresAt) > Date.now() + 60000
    || createHash('sha256').update(canonicalExecutorJson(authority)).digest('hex') !== digest) return refuse()
  const reread = await loadExecutorState(stateDirectory)
  if (reread.executorId !== state.executorId || reread.apiBaseUrl !== state.apiBaseUrl
    || reread.connectionEpoch !== state.connectionEpoch || reread.machinePublicKey !== state.machinePublicKey) {
    return refuse()
  }
  // This challenge is never consumed: only its fresh owner/team projection
  // prepares custody. The actual user key later proves a separate challenge.
  return challenge.principal
}

export const prepareChatgptProfilePrincipal = async (
  stateDirectory: string, profile: ChatgptProfileRecord, intent: PersonalChatgptConnectIntent,
) => {
  await matchingChatgptPairing(stateDirectory, intent)
  const principal = await prepareChatgptPairingPrincipal(stateDirectory, profile.profileId)
  if (principal.serverOrigin !== intent.apiOrigin || principal.organizationId !== intent.organizationId
    || principal.teamId !== intent.teamId) return refuse()
  return principal
}

/** Fresh server/UOA projection; stored local principal fields never grant membership. */
export const renewChatgptProfileAuthority = async (input: {
  stateDirectory: string; intent: PersonalChatgptConnectIntent; profile: ChatgptProfileRecord
  key: ChatgptCompanionKey; api?: Pick<ExecutorApiClient, 'personalChatgpt'>; now?: () => number
  /** Paired api/readState fixture dependencies; production Windows authority stays service-only. */
  readState?: () => Promise<ExecutorLocalState>
}): Promise<ExecutorChatgptContext> => {
  // Explicit in-memory dependencies exercise the portable signature contract;
  // no production call can select an interactive Windows machine-key path.
  if (!input.readState || !input.api) requireChatgptServiceAuthority(input.stateDirectory)
  if (windowsServiceExecutorId(input.stateDirectory)) return new WindowsServiceChatgptAuthority(input.stateDirectory)
    .renew({ intent: input.intent, profile: input.profile, key: input.key })
  const api = input.api ?? executorApi
  const now = input.now ?? Date.now
  const read = input.readState ?? (() => loadExecutorState(input.stateDirectory))
  const state = validateChatgptPairingState(await read(), input.intent)
  if (input.profile.profileId !== input.intent.profileId || input.profile.publicKey !== input.key.publicKey) refuse()
  const fingerprint = chatgptCompanionFingerprint(input.key)
  const request = { executorId: state.executorId, connectionEpoch: state.connectionEpoch!,
    observedAt: new Date(now()).toISOString(), nonce: randomOAuthValue(), profileId: input.profile.profileId,
    publicKey: input.key.publicKey, serverOrigin: input.intent.apiOrigin }
  const challenge = ExecutorChatgptDelegationChallengeSchema.parse(await api.personalChatgpt(state.apiBaseUrl,
    'challenge', ExecutorChatgptDelegationChallengeRequestSchema.parse({ ...request,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.challenge', request) })))
  const authorityBody = { challengeId: challenge.challengeId, nonce: challenge.nonce, executorId: challenge.executorId,
    profileId: challenge.profileId, connectionEpoch: challenge.connectionEpoch, role: challenge.role,
    publicKeyFingerprint: challenge.publicKeyFingerprint, principal: challenge.principal,
    deployment: challenge.deployment, expiresAt: challenge.expiresAt }
  if (challenge.executorId !== state.executorId || challenge.profileId !== input.profile.profileId
    || challenge.connectionEpoch !== state.connectionEpoch || challenge.publicKeyFingerprint !== fingerprint
    || challenge.principal.serverOrigin !== input.intent.apiOrigin
    || challenge.principal.organizationId !== input.intent.organizationId
    || challenge.principal.teamId !== input.intent.teamId
    || Date.parse(challenge.expiresAt) <= now() || Date.parse(challenge.expiresAt) > now() + 60_000
    || createHash('sha256').update(canonicalExecutorJson(authorityBody)).digest('hex') !== challenge.digest
    || input.profile.principal
      && !samePersonalInferenceCustodian(input.profile.principal, challenge.principal)) refuse()
  const proof = { challengeId: challenge.challengeId, digest: challenge.digest }
  const confirmation = { executorId: state.executorId, connectionEpoch: state.connectionEpoch!,
    observedAt: new Date(now()).toISOString(), nonce: randomOAuthValue(), ...proof,
    companionSignature: signChatgptCompanionProof(input.key, proof) }
  const context = ExecutorChatgptContextSchema.parse(await api.personalChatgpt(state.apiBaseUrl,
    'delegate', ExecutorChatgptDelegationConfirmSchema.parse({ ...confirmation,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.delegate', confirmation) })))
  const reread = validateChatgptPairingState(await read(), input.intent)
  if (reread.connectionEpoch !== state.connectionEpoch || reread.machinePublicKey !== state.machinePublicKey
    || reread.machinePrivateKey !== state.machinePrivateKey || context.connectionEpoch !== state.connectionEpoch
    || context.executorId !== state.executorId || context.profileId !== input.profile.profileId
    || context.publicKeyFingerprint !== fingerprint || context.nonce !== confirmation.nonce
    || canonicalExecutorJson(context.principal) !== canonicalExecutorJson(challenge.principal)
    || Date.parse(context.expiresAt) <= now() || Date.parse(context.expiresAt) > now() + 15 * 60_000
    || Date.parse(context.observedAt) > now() + 5000 || context.deployment !== challenge.deployment) refuse()
  return context
}
