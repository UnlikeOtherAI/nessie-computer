import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutorChatgptDisconnectSchema, PersonalChatgptConnectIntentSchema } from '@nessie/executor-protocol'
import { z } from 'zod'
import { executorApi } from './api-client.js'
import { randomOAuthValue } from './chatgpt-oauth-provider.js'
import { validateChatgptPairingState } from './chatgpt-profile-authority.js'
import type { ChatgptProfileRecord } from './chatgpt-profile-records.js'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { createPersonalStateMutation, type PersonalStateMutation } from './personal-state-mutation.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'
import { ChatgptReceiptCustody } from './chatgpt-receipt-custody.js'
import { WindowsServiceChatgptAuthority, windowsServiceExecutorId,
  requireChatgptServiceAuthority } from './chatgpt-windows-service-authority.js'
import { loadExecutorState } from './state-store.js'

export const chatgptProfileIntent = (profile: ChatgptProfileRecord) => PersonalChatgptConnectIntentSchema.parse({
  version: 1, kind: 'personal-chatgpt-connect', apiOrigin: profile.apiOrigin, executorId: profile.executorId,
  organizationId: profile.organizationId, teamId: profile.teamId, profileId: profile.profileId,
})

export const disconnectChatgptDelegation = async (
  stateDirectory: string, profile: ChatgptProfileRecord,
): Promise<void> => {
  requireChatgptServiceAuthority(stateDirectory)
  if (windowsServiceExecutorId(stateDirectory)) {
    return new WindowsServiceChatgptAuthority(stateDirectory).disconnect(profile)
  }
  const state = validateChatgptPairingState(await loadExecutorState(stateDirectory), chatgptProfileIntent(profile))
  const payload = { executorId: state.executorId, connectionEpoch: state.connectionEpoch!,
    observedAt: new Date().toISOString(), nonce: randomOAuthValue(), profileId: profile.profileId,
    serverOrigin: profile.apiOrigin, organizationId: profile.organizationId, teamId: profile.teamId }
  z.object({ disconnected: z.literal(true) }).strict().parse(await executorApi.personalChatgpt(state.apiBaseUrl,
    'disconnect', ExecutorChatgptDisconnectSchema.parse({ ...payload,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, 'chatgpt.disconnect', payload) })))
}

/** This public controller never opens provider credential bytes. */
export const finalizeChatgptDisconnect = async (
  stateDirectory: string, profile: ChatgptProfileRecord,
  // Code-only fixture seams; local operations cannot supply dependencies.
  dependencies: {
    store?: ChatgptProfileStore
    mutation?: PersonalStateMutation
    guard?: Pick<PersonalInferenceGuard, 'deactivate'>
    disconnect?: typeof disconnectChatgptDelegation
  } = {},
): Promise<void> => {
  if (profile.phase !== 'disconnecting') throw new PersonalInferenceProtectionError('chatgpt_disconnect_fenced')
  // A revoked parent or unavailable server cannot preserve local credential
  // authority after every secret/outbox/process is positively gone. Historical
  // liabilities are still checked below and must have their original ACKs.
  await (dependencies.disconnect ?? disconnectChatgptDelegation)(stateDirectory, profile).catch(() => undefined)
  const store = dependencies.store ?? new ChatgptProfileStore()
  const mutation = dependencies.mutation ?? await createPersonalStateMutation()
  const directory = store.profileDirectory(profile.profileId)
  await (dependencies.guard ?? PersonalInferenceGuard.open()).deactivate(profile.profileId, async () => {
    for (const name of ['credentials.json', 'companion-key.json']) {
      const credentials = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (credentials) throw new PersonalInferenceProtectionError('chatgpt_credentials_not_cleared')
    }
    await ChatgptReceiptCustody.assertCleared(join(directory, 'receipts', String(profile.accountGeneration),
      String(profile.consentRevision)), join(mutation.root, 'cloud-capacity', profile.profileId,
      String(profile.accountGeneration), String(profile.consentRevision)), mutation)
    await mutation.barrier(directory)
  })
  await store.update(profile.profileId, prior => {
    if (!prior || prior.phase !== 'disconnecting' || prior.operationId !== profile.operationId) {
      throw new PersonalInferenceProtectionError('chatgpt_disconnect_fenced')
    }
    return { ...prior, revision: prior.revision + 1, phase: 'disconnected', reason: null,
      planEnabled: false, hostExecutionRestricted: false, credentialProcess: null, operationId: null, publicKey: null }
  })
}
