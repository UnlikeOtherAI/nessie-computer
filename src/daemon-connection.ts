import {
  FolderSyncHeartbeatSummarySchema,
  ExecutorMonitorSnapshotSchema,
  ExecutorMonitorRequestSchema,
  type ExecutorMonitorRequest,
  type ExecutorMonitorSnapshot,
  type ExecutorDaemonHeartbeatWithFolderSyncRequest,
  type ExecutorLocalMcpReport,
  type FolderSyncHeartbeatSummary,
  ExecutorSoftwareStatusSchema,
  ExecutorSoftwareUpdateRequestSchema,
  type ExecutorSoftwareStatus,
  type ExecutorSoftwareUpdateRequest,
} from '@nessie/executor-protocol'
import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { signedDescriptorForState } from './pair.js'
import { loadExecutorState, saveExecutorState, type ExecutorLocalState } from './state-store.js'

type ClaimDependencies = {
  api: Pick<ExecutorApiClient, 'issueChallenge' | 'claim' | 'submitDescriptor'>
  loadState: typeof loadExecutorState
  saveState: typeof saveExecutorState
}

/** Claim once, then publish this machine's current policy under an immutable revision. */
export const claimExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
  dependencies: ClaimDependencies = { api: executorApi, loadState: loadExecutorState, saveState: saveExecutorState },
): Promise<ExecutorLocalState> => {
  const issued = await dependencies.api.issueChallenge(state.apiBaseUrl, state.executorId)
  const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'claim', {
    challenge: issued.challenge, executorId: state.executorId,
  })
  const connection = await dependencies.api.claim(state.apiBaseUrl, {
    challenge: issued.challenge, executorId: state.executorId, signature,
  })
  // Another local writer may have changed policy while the claim was in flight.
  const persisted = await dependencies.loadState(stateDir)
  const next = { ...persisted, connectionEpoch: connection.connectionEpoch }
  const submit = () => dependencies.api.submitDescriptor(next.apiBaseUrl, {
    connectionEpoch: connection.connectionEpoch, descriptor: signedDescriptorForState(next),
    executorId: next.executorId,
  })
  try {
    await submit()
  } catch (error) {
    if (!(error instanceof ExecutorApiError) || error.code !== 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT') throw error
    // OS/backend/supervisor facts are detected at signing time. A reboot or a
    // move from CLI to desktop can change them without changing local policy.
    // Never overwrite the server's immutable revision. Save a fresh revision
    // before sending it so a lost response replays that exact revision.
    next.descriptor = { ...persisted.descriptor, revision: persisted.descriptor.revision + 1 }
    await dependencies.saveState(stateDir, next, persisted)
    await submit()
    return next
  }
  await dependencies.saveState(stateDir, next, persisted)
  return next
}

/**
 * Sends one heartbeat and answers with the heartbeat's `codingSessionClose`
 * instructions, unparsed: `CodingSessionsDaemon.close` validates them, so a
 * field this daemon does not know never fails the heartbeat itself.
 */
export const heartbeatExecutor = async (
  state: ExecutorLocalState,
  localMcp?: ExecutorLocalMcpReport,
  onExistingSessionAccess?: (allowed: boolean) => void,
  folderSync?: FolderSyncHeartbeatSummary,
  api: Pick<ExecutorApiClient, 'heartbeat'> = executorApi,
  updates?: { status: ExecutorSoftwareStatus;
    onRequest: (request: ExecutorSoftwareUpdateRequest) => Promise<void> | void },
  monitor?: ExecutorMonitorSnapshot,
  onMonitorRequest?: (request: ExecutorMonitorRequest | null) => void,
): Promise<unknown> => {
  if (!state.connectionEpoch) {
    throw new Error('Executor has not claimed a live daemon connection.')
  }
  const observedAt = new Date().toISOString()
  // Each optional field joins the signed payload exactly when it is present.
  // Canonical JSON distinguishes an absent key from a present one, so a daemon
  // that reports nothing still signs — and verifies — the payload it always did.
  const signed = {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    // Checked against its contract before it is signed.
    ...(folderSync === undefined ? {} : { folderSync: FolderSyncHeartbeatSummarySchema.parse(folderSync) }),
    ...(localMcp === undefined ? {} : { localMcp }),
    ...(updates === undefined ? {} : { software: ExecutorSoftwareStatusSchema.parse(updates.status) }),
    observedAt,
    ...(monitor === undefined ? {} : { monitor: ExecutorMonitorSnapshotSchema.parse(monitor) }),
    ...(onMonitorRequest ? { monitorVersion: 1 as const } : {}),
  }
  const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'heartbeat', signed)
  type HeartbeatBody = Omit<ExecutorDaemonHeartbeatWithFolderSyncRequest, 'executorId'> & { executorId: string }
  const body: HeartbeatBody = { ...signed, signature }
  const response = await api.heartbeat(state.apiBaseUrl, body)
  onExistingSessionAccess?.(response.existingSessionsAllowed === true)
  if (onMonitorRequest) {
    const request = ExecutorMonitorRequestSchema.safeParse(response.monitorRequest)
    onMonitorRequest(request.success ? request.data : null)
  }
  if (response.softwareUpdateRequest && updates) {
    const request = ExecutorSoftwareUpdateRequestSchema.safeParse(response.softwareUpdateRequest)
    if (request.success) {
      // Update delivery is retried independently. A coordinator refusal must not
      // turn a successful heartbeat into a connection failure that stops work.
      void Promise.resolve().then(() => updates.onRequest(request.data)).catch(() => undefined)
    }
  }
  return response.codingSessionClose
}

