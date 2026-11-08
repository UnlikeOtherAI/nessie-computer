import { open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { LOCAL_INFERENCE_PROTOCOL_VERSION } from '@nessie/executor-protocol'
import { signLocalInferenceEnvelope } from '@nessie/local-inference-host'

import { executorApi } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { createLocalInferenceDaemonApi } from './local-inference-api.js'
import { startLocalInferenceHostSession, type LocalInferenceHostSession } from './local-inference-host-session.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from './local-inference-receipts.js'
import { DEFAULT_OLLAMA_ORIGIN } from './ollama-client.js'
import { readInferenceEndpoints } from './inference-endpoints.js'
import { createInferenceEndpointBackend } from './inference-endpoint-backend.js'
import {
  ensureExecutorRuntimeDirectory,
  newLocalInferenceReceiptJournalKey,
  saveExecutorState,
  type ExecutorLocalState,
} from './state-store.js'

const RECEIPT_FILE = 'local-inference-receipts.json'

type ConnectedLocalInference = {
  session: LocalInferenceHostSession
  state: ExecutorLocalState
}

const receiptPath = async (stateDir: string): Promise<string> =>
  join(await ensureExecutorRuntimeDirectory(stateDir), RECEIPT_FILE)

const replaceReceiptFile = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${process.pid}.new`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

const localHostRegistration = async (state: ExecutorLocalState): Promise<{
  connectionEpoch: string
  hostId: string
  organizationId: string
}> => {
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const observedAt = new Date().toISOString()
  const payload = { connectionEpoch: state.connectionEpoch, executorId: state.executorId, observedAt }
  return executorApi.localInferenceHost(state.apiBaseUrl, {
    ...payload,
    signature: signExecutorDaemonPayload(state.machinePrivateKey, 'local_inference.host', payload),
  })
}

/** Claims a host the executor registered, under its live executor connection; answers the host's new epoch. */
export const claimLocalHost = async (
  state: ExecutorLocalState,
  local: { connectionEpoch: string; hostId: string; organizationId: string },
): Promise<string> => {
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const api = createLocalInferenceDaemonApi({ apiBaseUrl: state.apiBaseUrl })
  const issued = await api.issueChallenge({ hostId: local.hostId })
  const challenge = { challenge: issued.challenge }
  const envelope = signLocalInferenceEnvelope({
    body: challenge,
    header: {
      connectionEpoch: local.connectionEpoch,
      executorConnectionEpoch: state.connectionEpoch,
      hostId: local.hostId,
      organizationId: local.organizationId,
      protocolVersion: LOCAL_INFERENCE_PROTOCOL_VERSION,
      purpose: 'claim',
      sentAt: new Date().toISOString(),
      sequence: 1,
    },
    machinePrivateKey: state.machinePrivateKey,
  })
  const connected = await api.claim({ challenge: issued.challenge, envelope })
  return connected.connectionEpoch
}

/** One host's encrypted receipt journal in one owner-only file. */
export const openLocalInferenceReceiptJournal = (path: string, key: Buffer): EncryptedLocalInferenceReceiptJournal =>
  new EncryptedLocalInferenceReceiptJournal({
    read: async () => {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as {
          ciphertext: string
          iv: string
          tag: string
          version: 1
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    remove: async () => { await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }) },
    write: (value) => replaceReceiptFile(path, value),
  }, key)

/**
 * Claim the local host immediately after its parent executor claim, then open
 * its socket. The host identity and receipt key remain in the executor's
 * owner-only state; a descriptor, workspace grant, browser process, or Nessie
 * itself never sees the receipt key.
 */
export const connectExecutorLocalInference = async (
  stateDir: string,
  state: ExecutorLocalState,
): Promise<ConnectedLocalInference> => {
  const registered = await localHostRegistration(state)
  const existing = state.localInference
  const sameHost = existing !== undefined
    && existing.hostId === registered.hostId
    && existing.organizationId === registered.organizationId
  const withHost = sameHost
    ? state
    : {
      ...state,
      localInference: {
        connectionEpoch: registered.connectionEpoch,
        hostId: registered.hostId,
        organizationId: registered.organizationId,
        receiptJournalKey: newLocalInferenceReceiptJournalKey(),
      },
    }
  if (withHost !== state) await saveExecutorState(stateDir, withHost, state)
  const local = withHost.localInference
  if (!local) throw new Error('Local inference state was not persisted.')
  const connectionEpoch = await claimLocalHost(withHost, local)
  const connected = {
    ...withHost,
    localInference: { ...local, connectionEpoch },
  }
  await saveExecutorState(stateDir, connected, withHost)
  const journal = openLocalInferenceReceiptJournal(await receiptPath(stateDir),
    Buffer.from(connected.localInference.receiptJournalKey, 'base64url'))
  const localBackend = createInferenceEndpointBackend(() => readInferenceEndpoints(stateDir))
  return {
    session: startLocalInferenceHostSession({
      apiBaseUrl: connected.apiBaseUrl,
      backend: localBackend,
      coordinator: await LocalInferenceCoordinator.open(),
      identity: {
        connectionEpoch: connected.localInference.connectionEpoch,
        executorConnectionEpoch: connected.connectionEpoch,
        hostId: connected.localInference.hostId,
        machinePrivateKey: connected.machinePrivateKey,
        organizationId: connected.localInference.organizationId,
      },
      isPaused: () => false,
      journal,
      origin: DEFAULT_OLLAMA_ORIGIN,
    }),
    state: connected,
  }
}
