import type {
  LocalInferenceAttemptRequest, LocalInferenceResourceAdmission, LocalInferenceTermination,
} from '@nessie/executor-protocol'
import type { LocalInferenceResultReceipt } from './local-inference-api.js'
import type { EncryptedLocalInferenceReceiptJournal } from './local-inference-receipts.js'
import { ChatgptError } from './chatgpt-errors.js'

/** No prompt, tools, credentials or signing key are part of retained origin input. */
export type PersonalReceiptAttempt = Pick<LocalInferenceAttemptRequest,
  'attemptId' | 'hostId' | 'hostEpoch' | 'runId' | 'runFence' | 'invocationId' | 'bindingId'
  | 'bindingRevision' | 'modelName' | 'modelDigest' | 'inferenceSource' | 'personalAuthority'>
export type PersonalReceiptHost = {
  hostId: string; organizationId: string; connectionEpoch: string; executorConnectionEpoch?: string
}
export type PersonalReceiptTransport = {
  prepareInvocation: (input: { attemptId: string; dispatchFence: number }) => Promise<void>
  retainAttempt: (input: { attempt: PersonalReceiptAttempt; dispatchFence: number;
    host: PersonalReceiptHost; admission: LocalInferenceResourceAdmission }) => Promise<void>
  result: (receipt: LocalInferenceResultReceipt) => Promise<{ acknowledged: true }>
  termination: (termination: LocalInferenceTermination) => Promise<{ acknowledged: true }>
}

/** Both protected outcome capacity and original signing origin commit before accept or POST. */
export const retainPersonalReceiptAttempt = async (input: {
  attempt: LocalInferenceAttemptRequest; dispatchFence: number; admission: LocalInferenceResourceAdmission;
  host: PersonalReceiptHost; journal: EncryptedLocalInferenceReceiptJournal; transport?: PersonalReceiptTransport
}): Promise<void> => {
  const { attempt, dispatchFence, journal, transport } = input
  if (!transport || attempt.inferenceSource?.kind !== 'chatgpt') {
    throw new ChatgptError('chatgpt_unavailable', 'not_sent')
  }
  const { attemptId, hostId, hostEpoch, runId, runFence, invocationId, bindingId, bindingRevision,
    modelName, modelDigest, inferenceSource, personalAuthority } = attempt
  const { hostId: originalHostId, organizationId, connectionEpoch, executorConnectionEpoch } = input.host
  try {
    await transport.retainAttempt({ dispatchFence, admission: structuredClone(input.admission),
      host: { hostId: originalHostId, organizationId, connectionEpoch, executorConnectionEpoch },
      attempt: { attemptId, hostId, hostEpoch, runId, runFence, invocationId, bindingId, bindingRevision,
        modelName, modelDigest, inferenceSource, personalAuthority } })
    await journal.reservePersonalAttempt({ attemptId, dispatchFence, inferenceSource: attempt.inferenceSource })
  } catch { throw new ChatgptError('chatgpt_unavailable', 'not_sent') }
}
