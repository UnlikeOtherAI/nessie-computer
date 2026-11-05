import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatgptReceiptCustody } from './chatgpt-receipt-custody.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from './local-inference-receipts.js'
import { chatgptProfileSource } from './chatgpt-profile-records.js'
import { chatgptBytesDigest, ChatgptProfileStore } from './chatgpt-profile-store.js'
import type { ChatgptProfileRecord } from './chatgpt-profile-records.js'
import type { ChatgptProfileKey } from './chatgpt-profile-key.js'
import type { ManagedChatgptCredentialRuntime } from './chatgpt-managed-runtime.js'

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Only before session launch or after its scheduler drains; never while work can invoke. */
export const reconcileStoppedChatgptReceipts = async (input: {
  custody: ChatgptReceiptCustody; journal: EncryptedLocalInferenceReceiptJournal
  coordinator: LocalInferenceCoordinator
}): Promise<void> => {
  const { custody, journal, coordinator } = input
  for (const reservation of await journal.pendingReservations()) {
    const result = await custody.recoveryReceipt(reservation)
    // Convert the original reserved slot to an encrypted retained result first.
    // API failure then retries these exact bytes, not a provider invocation.
    await journal.record(result)
  }
  for (const receipt of await journal.pending()) {
    await custody.transport.result(receipt)
    await journal.acknowledge(receipt)
  }
  await coordinator.flushTerminations(value => custody.transport.termination(value).then(() => undefined))
  await custody.reconcileAcknowledgements()
}

/** Registered credential child only; no new claims, model discovery or provider POST. */
export const clearChatgptOutboxKeys = async (input: {
  runtime: ManagedChatgptCredentialRuntime; profile: ChatgptProfileRecord; key: ChatgptProfileKey | null
}): Promise<boolean> => {
  await input.runtime.authority.assertCurrent('clear')
  const { profile, runtime } = input
  const profileDirectory = new ChatgptProfileStore().profileDirectory(profile.profileId)
  const directory = join(profileDirectory, 'receipts',
    String(profile.accountGeneration), String(profile.consentRevision))
  const capacity = join(runtime.mutation.root, 'cloud-capacity', profile.profileId,
    String(profile.accountGeneration), String(profile.consentRevision))
  const exists = await lstat(directory).catch(error => { if (missing(error)) return null; throw error })
  if (exists) {
    if (!input.key) return false
    const context = await ChatgptReceiptCustody.historicalContext(directory)
    await runtime.mutation.ensureDirectory(capacity)
    const coordinator = await LocalInferenceCoordinator.openChatgpt(chatgptProfileSource(profile), {
      directory: capacity,
      cloudMutation: runtime.mutation.mutate, cloudBarrier: runtime.mutation.barrier })
    let journal!: EncryptedLocalInferenceReceiptJournal
    const custody = new ChatgptReceiptCustody({ mutation: runtime.mutation, context, key: input.key,
      accountGeneration: profile.accountGeneration, consentRevision: profile.consentRevision,
      canForget: async id => !await journal.hasPendingAttempt(id) && !await coordinator.hasPendingTermination(id) })
    journal = new EncryptedLocalInferenceReceiptJournal(custody.storage, Buffer.from(input.key.receiptKey, 'base64url'),
      () => new Date(), { personalCapacity: 4 })
    await reconcileStoppedChatgptReceipts({ custody, journal, coordinator })
    if (!await custody.settled() || (await journal.pending()).length !== 0) return false
    await runtime.mutation.barrier(directory)
    // This key signs only the old cloud resource. No private resource draft
    // may survive publication: the coordinator's cloud consumer uses native CAS.
  }
  // A coordinator may publish its key before receipt storage opens. With no
  // receipt origins it still needs an explicit empty-slot/termination proof.
  const capacityExists = await lstat(capacity).catch(error => { if (missing(error)) return null; throw error })
  if (capacityExists) {
    const coordinator = await LocalInferenceCoordinator.openChatgpt(chatgptProfileSource(profile), {
      directory: capacity, cloudMutation: runtime.mutation.mutate, cloudBarrier: runtime.mutation.barrier })
    // Includes unbound slots and every termination, even when a crash happened
    // before the receipt directory/origin could be created.
    if (await coordinator.hasPendingCloudWork()) return false
    const resourceKey = join(capacity, 'resource-key.json')
    const resourceBytes = await readFile(resourceKey).catch(error => { if (missing(error)) return null; throw error })
    if (resourceBytes) await runtime.mutation.mutate(resourceKey, {
      operation: 'delete', expectedDigest: chatgptBytesDigest(resourceBytes),
    })
    await runtime.mutation.barrier(capacity)
  }
  const path = join(profileDirectory, 'companion-key.json')
  const bytes = await readFile(path).catch(error => { if (missing(error)) return null; throw error })
  if (bytes) await runtime.mutation.mutate(path, { operation: 'delete', expectedDigest: chatgptBytesDigest(bytes) })
  await runtime.mutation.barrier(profileDirectory)
  return true
}
