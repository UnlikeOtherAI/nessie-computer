import { randomUUID } from 'node:crypto'
import { PersonalChatgptConsoleOperationSchema, PersonalChatgptLocalOperationSchema,
  type PersonalChatgptConnectIntent } from '@nessie/executor-protocol'
import { ChatgptProfileStore } from './chatgpt-profile-store.js'
import { prepareChatgptPairingPrincipal, matchingChatgptPairing,
  readChatgptPairingReference } from './chatgpt-profile-authority.js'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

/** The desktop supplies neither paths nor owner/team claims in its public operation. */
export const resolveChatgptLocalOperation = async (stateDirectory: string, input: unknown) => {
  const operation = PersonalChatgptLocalOperationSchema.parse(input)
  const store = new ChatgptProfileStore()
  const state = await readChatgptPairingReference(stateDirectory)
  const apiOrigin = new URL(state.apiBaseUrl).origin
  const selected = operation.operation === 'cancel' ? await store.operation(operation.operationId)
    : 'profileId' in operation && operation.profileId ? await store.read(operation.profileId) : null
  if (operation.operation === 'cancel' || ('profileId' in operation && operation.profileId)) {
    if (!selected || selected.executorId !== state.executorId || selected.apiOrigin !== apiOrigin) {
      throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
    }
  }
  const existing = selected ? [] : await store.connection(apiOrigin, state.executorId)
  if (new Set(existing.map(profile => `${profile.organizationId}/${profile.teamId}`)).size > 1) {
    throw new PersonalInferenceProtectionError('chatgpt_operation_fenced')
  }
  const principal = selected ?? existing[0] ?? await prepareChatgptPairingPrincipal(stateDirectory, randomUUID())
  const intent: PersonalChatgptConnectIntent = { version: 1, kind: 'personal-chatgpt-connect',
    apiOrigin, executorId: state.executorId, organizationId: principal.organizationId,
    teamId: principal.teamId, ...(selected ? { profileId: selected.profileId } : {}) }
  await matchingChatgptPairing(stateDirectory, intent)
  if (operation.operation === 'cancel') return PersonalChatgptConsoleOperationSchema.parse(operation)
  const publicOperation = Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'profileId'))
  return PersonalChatgptConsoleOperationSchema.parse({ ...publicOperation, intent })
}
