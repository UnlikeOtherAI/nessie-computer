import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LOCAL_CLI_HOST_SIGNATURE_DOMAIN, type LocalCliEngine, type LocalCliWithdrawReason,
} from '@nessie/executor-protocol'

import { signExecutorDaemonPayload } from './daemon-signature.js'
import { createLocalInferenceDaemonApi, LocalInferenceApiError, type LocalInferenceDaemonApi } from './local-inference-api.js'
import { LocalInferenceCoordinator } from './local-inference-coordinator.js'
import { startLocalInferenceHostSession, type LocalInferenceHostSession } from './local-inference-host-session.js'
import { claimLocalHost, openLocalInferenceReceiptJournal } from './local-inference-runtime.js'
import type { LocalInferenceBackend } from './local-inference-backend.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { ensureOwnerOnlyStateDirectory, assertOwnerOnlyStatePath } from './state-security.js'
import { newLocalInferenceReceiptJournalKey, type ExecutorLocalState } from './state-store.js'

/**
 * One Claude Code or Codex engine connection as a local-inference host of
 * role `local_cli` (docs/local-cli-engines.md): registered through its own
 * route, then the unchanged claim, socket and attempt protocol, with its own
 * resource pool and receipt journal in the team's state folder.
 */
export type LocalCliRegistration =
  | { kind: 'host'; hostId: string; organizationId: string; connectionEpoch: string }
  | { kind: 'withdrawn' }
  /** An older Nessie that has no such route; nothing is offered. */
  | { kind: 'unsupported' }

const FOLDER = 'local-cli-engines'

/** Offers the engine connection (`true`), or withdraws it naming why. */
export const registerLocalCliHost = async (
  state: ExecutorLocalState, engine: LocalCliEngine, profileId: string | null, offer: true | LocalCliWithdrawReason,
  api: Pick<LocalInferenceDaemonApi, 'registerCliHost'>
    = createLocalInferenceDaemonApi({ apiBaseUrl: state.apiBaseUrl }),
  now: () => Date = () => new Date(),
): Promise<LocalCliRegistration> => {
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const payload = { available: offer === true, connectionEpoch: state.connectionEpoch, engine,
    executorId: state.executorId, observedAt: now().toISOString(), profileId, ...(offer === true ? {} : { reason: offer }) }
  try {
    const answer = await api.registerCliHost({ ...payload,
      signature: signExecutorDaemonPayload(state.machinePrivateKey, LOCAL_CLI_HOST_SIGNATURE_DOMAIN, payload) })
    return 'withdrawn' in answer ? { kind: 'withdrawn' } : { kind: 'host', ...answer }
  } catch (error) {
    if (error instanceof LocalInferenceApiError && error.status === 404) return { kind: 'unsupported' }
    throw error
  }
}

const receiptKey = async (directory: string): Promise<Buffer> => {
  const path = join(directory, 'receipt-key.json')
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await replaceOwnerOnlyJson(path, { key: newLocalInferenceReceiptJournalKey() })
  }
  await assertOwnerOnlyStatePath(path, 'file')
  const value = JSON.parse(await readFile(path, 'utf8')) as { key?: unknown }
  if (typeof value.key !== 'string') throw new Error('Local CLI engine receipt key needs repair.')
  return Buffer.from(value.key, 'base64url')
}

/** Claims the registered host and opens its socket; the caller heartbeats and stops it. */
export const connectLocalCliHost = async (input: {
  stateDir: string; state: ExecutorLocalState; engine: LocalCliEngine; profileId: string | null
  host: { hostId: string; organizationId: string; connectionEpoch: string }
  backend: LocalInferenceBackend; isPaused: () => boolean
}): Promise<LocalInferenceHostSession> => {
  const { state } = input
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
  const root = await ensureOwnerOnlyStateDirectory(join(input.stateDir, FOLDER))
  const pool = await ensureOwnerOnlyStateDirectory(join(root, `${input.engine}-${input.profileId ?? 'default'}`))
  const connectionEpoch = await claimLocalHost(state, input.host)
  return startLocalInferenceHostSession({
    apiBaseUrl: state.apiBaseUrl,
    backend: input.backend,
    coordinator: await LocalInferenceCoordinator.open({ directory: pool }),
    identity: {
      connectionEpoch, executorConnectionEpoch: state.connectionEpoch, hostId: input.host.hostId,
      machinePrivateKey: state.machinePrivateKey, organizationId: input.host.organizationId,
    },
    isPaused: input.isPaused,
    journal: openLocalInferenceReceiptJournal(join(pool, 'receipts.json'), await receiptKey(root)),
    // A CLI backend never dials an origin; the loop only forwards this to the backend.
    origin: `local-cli:${input.engine}`,
    onError: (error) => {
      console.error(`[nessie-executor] ${input.engine} claim failed:`, error instanceof Error ? error.message : String(error))
    },
  })
}
