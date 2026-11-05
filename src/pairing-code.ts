import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { hostname } from 'node:os'
import { newLocalCommandPolicy } from './command-policy.js'

import {
  canonicalExecutorPayload,
  EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  ExecutorPairingClaimSchema,
  ExecutorPairingPollResponseSchema,
  ExecutorPairingStartResponseSchema,
  type ExecutorPairingClaim,
  type ExecutorPairingPollResponse,
} from '@nessie/executor-protocol'

import { acquireExecutorDaemonLease } from './daemon-lease.js'
import { executorApi, type ExecutorApiClient } from './api-client.js'
import { buildSignedDescriptor } from './descriptor.js'
import { configureExecutorWorkspaceFolders } from './pair.js'
import { clearPairingCode, loadPairingCode, savePairingCode, type PendingPairingCode } from './pairing-code-store.js'
import { clearExecutorState, loadExecutorState, saveExecutorState, type ExecutorLocalState } from './state-store.js'
import { executorWorkspaceFolderNames, type ExecutorWorkspaceFolder } from './workspace-folders.js'
import { acquireExecutorProcessLease } from './process-lease.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'
import { assertWorkspaceMayChange } from './workspace-retirement.js'

export type PairingCodeView = {
  status: 'idle' | 'waiting' | 'paired' | 'alreadyPaired' | 'expired' | 'cancelled'
  code?: string
  expiresAt?: string
  executorId?: string
  fingerprint?: string
  machineName?: string
  organizationName?: string
  teamName?: string | null
  apiBaseUrl?: string
}

export const pairingSignature = (key: string, action: string, payload: Record<string, unknown>): string => sign(
  null,
  Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
  createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' }),
).toString('base64url')

export const postPairing: ExecutorApiClient['pairing'] = async (origin, action, body) => {
  try { return await executorApi.pairing(origin, action, body) } catch {
    throw new Error('Nessie could not complete pairing. Check your connection and try again.')
  }
}

/** Initial pairing may narrow the default workspace policy, never add host operations. */
export const pairingOperationKeys = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
    || value.some((operation) => typeof operation !== 'string'
      || !(EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS as readonly string[]).includes(operation))) {
    throw new Error('Choose distinct workspace operations for the initial pairing.')
  }
  return [...value] as string[]
}

const sameOperations = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((operation) => right.includes(operation))
)

const pairingDependencies = {
  acquireExecutorDaemonLease, clearExecutorState, clearPairingCode, configureExecutorWorkspaceFolders,
  loadExecutorState, loadPairingCode, postPairing, saveExecutorState, savePairingCode,
  assertWorkspaceMayChange,
  acquirePairingLease: async (directory: string) => {
    await ensureOwnerOnlyStateDirectory(directory)
    return acquireExecutorProcessLease(directory, 'pairing-operation.pid')
  },
}

/** Native hosts share one workflow; injectable storage and transport keep recovery tests independent of host ACLs. */
export const createPairingCodeClient = (overrides: Partial<typeof pairingDependencies> = {}) => {
  const {
    acquireExecutorDaemonLease, clearExecutorState, clearPairingCode, configureExecutorWorkspaceFolders,
    loadExecutorState, loadPairingCode, postPairing, saveExecutorState, savePairingCode,
    acquirePairingLease,
    assertWorkspaceMayChange,
  } = { ...pairingDependencies, ...overrides }

  const existingState = async (directory: string): Promise<ExecutorLocalState | null> => (
    loadExecutorState(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
  )

  const labels = (claim: ExecutorPairingClaim): Pick<
  PairingCodeView, 'executorId' | 'machineName' | 'organizationName' | 'teamName'
  > => ({
    executorId: claim.executorId, machineName: claim.machineName,
    organizationName: claim.organization.name, teamName: claim.team?.name ?? null,
  })

  const connectedView = async (state: ExecutorLocalState): Promise<PairingCodeView> => {
    const payload = { executorId: state.executorId, timestamp: new Date().toISOString() }
    const claim = ExecutorPairingClaimSchema.parse(await postPairing(state.apiBaseUrl, 'connection', {
      ...payload, signature: pairingSignature(state.machinePrivateKey, 'connection', payload),
    }))
    return { status: 'paired', apiBaseUrl: state.apiBaseUrl, ...labels(claim) }
  }

  const localPolicy = (
    folders: ExecutorWorkspaceFolder[],
    operations: readonly string[] = EXECUTOR_WORKSPACE_ONLY_OPERATION_KEYS,
  ): ExecutorLocalState['descriptor'] => ({
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
    operationKeys: [...operations], profiles: ['workspace_sandbox'], revision: 1,
    workspaceFolders: executorWorkspaceFolderNames(folders),
  })

  const mint = async (
    directory: string, pending: PendingPairingCode, daemonLeaseHeld = false,
  ): Promise<PendingPairingCode> => {
    const { replacementSignature } = pending.request
    const original = {
      requestId: pending.request.requestId, machineName: pending.request.machineName,
      machinePublicKey: pending.request.machinePublicKey, descriptor: pending.request.descriptor,
      ...(pending.request.replacesExecutorId ? { replacesExecutorId: pending.request.replacesExecutorId } : {}),
    }
    const state = original.replacesExecutorId ? await existingState(directory) : null
    const lease = state && !daemonLeaseHeld ? await acquireExecutorDaemonLease(directory) : null
    try {
      const payload = { ...original, timestamp: new Date().toISOString() }
      const request = {
        ...payload, signature: pairingSignature(pending.machinePrivateKey, 'start', payload),
        ...(state ? { replacementSignature: pairingSignature(state.machinePrivateKey, 'replace', payload) }
          : replacementSignature ? { replacementSignature } : {}),
      }
      const response = ExecutorPairingStartResponseSchema.parse(await postPairing(pending.apiBaseUrl, 'start', request))
      const updated = { ...pending, request, response }
      await savePairingCode(directory, updated)
      // Retirement is server-confirmed before the old local key/grants disappear.
      if (state) await clearExecutorState(directory)
      return updated
    } finally { await lease?.release() }
  }

  const startPairingCode = async (input: {
    apiBaseUrl: string
    operationKeys?: string[]
    replace?: boolean
    stateDir: string
    workspaceFolders: ExecutorWorkspaceFolder[]
  }): Promise<PairingCodeView> => {
    const operations = pairingOperationKeys(input.operationKeys)
    const pending = await loadPairingCode(input.stateDir)
    if (pending) {
      if (operations && !sameOperations(operations, pending.request.descriptor.descriptor.operationKeys)) {
        throw new Error('This pairing already uses different operations. Finish it before choosing another policy.')
      }
      const view = await pairingCodeStatus(input.stateDir)
      if (view.status !== 'expired') return view
      // Only the server's poll outcome may retire an attempt: an old local deadline
      // can also belong to a claimed pairing whose answer has not arrived yet.
      await clearPairingCode(input.stateDir)
    }
    const existing = await existingState(input.stateDir)
    if (existing && !input.replace && operations
      && !sameOperations(operations, existing.descriptor.operationKeys)) {
      throw new Error('This computer is already paired with different operations. Change its permissions explicitly.')
    }
    if (existing && !input.replace) return { ...await connectedView(existing), status: 'alreadyPaired' }
    if (existing && existing.apiBaseUrl !== input.apiBaseUrl) {
      throw new Error('Replace this pairing in the same Nessie service. Disconnect it before choosing a different service.')
    }
    const lease = await acquireExecutorDaemonLease(input.stateDir)
    try {
      if (existing) await assertWorkspaceMayChange(input.stateDir)
      const folders = await configureExecutorWorkspaceFolders(input.workspaceFolders)
      const keys = generateKeyPairSync('ed25519')
      const machinePrivateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
      const payload = {
        requestId: randomUUID(), timestamp: new Date().toISOString(), machineName: hostname().slice(0, 120),
        machinePublicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
        descriptor: buildSignedDescriptor(machinePrivateKey, localPolicy(folders, operations)),
        ...(existing ? { replacesExecutorId: existing.executorId } : {}),
      }
      const prepared: PendingPairingCode = {
        apiBaseUrl: existing?.apiBaseUrl ?? input.apiBaseUrl, machinePrivateKey, workspaceFolders: folders,
        request: { ...payload, signature: pairingSignature(machinePrivateKey, 'start', payload),
          ...(existing ? { replacementSignature: pairingSignature(existing.machinePrivateKey, 'replace', payload) } : {}) },
      }
      await savePairingCode(input.stateDir, prepared)
      const started = await mint(input.stateDir, prepared, true)
      return { status: 'waiting', ...started.response, apiBaseUrl: started.apiBaseUrl, machineName: payload.machineName }
    } finally { await lease.release() }
  }

  const poll = async (pending: PendingPairingCode): Promise<ExecutorPairingPollResponse> => {
    if (!pending.response) throw new Error('Pairing has not started yet.')
    const payload = { pairingId: pending.response.pairingId, timestamp: new Date().toISOString(),
      machinePublicKey: pending.request.machinePublicKey }
    return ExecutorPairingPollResponseSchema.parse(await postPairing(pending.apiBaseUrl, 'poll', {
      ...payload, signature: pairingSignature(pending.machinePrivateKey, 'poll', payload),
    }))
  }

  const complete = async (
    directory: string, pending: PendingPairingCode, claim: ExecutorPairingClaim,
  ): Promise<void> => {
    const state = await existingState(directory)
    if (state && state.executorId !== claim.executorId) throw new Error('This computer already has another pairing.')
    if (!state) await saveExecutorState(directory, {
      commandPolicy: newLocalCommandPolicy(),
      apiBaseUrl: pending.apiBaseUrl,
      descriptor: localPolicy(pending.workspaceFolders, pending.request.descriptor.descriptor.operationKeys),
      executorId: claim.executorId,
      machinePrivateKey: pending.machinePrivateKey, machinePublicKey: pending.request.machinePublicKey,
      workspaceFolders: pending.workspaceFolders,
    })
    await clearPairingCode(directory)
  }

  const clearRetiredState = async (directory: string, pending: PendingPairingCode): Promise<void> => {
    if (!pending.response || !pending.request.replacesExecutorId) return
    const previous = await existingState(directory)
    if (previous?.executorId === pending.request.replacesExecutorId) {
      const lease = await acquireExecutorDaemonLease(directory)
      try { await clearExecutorState(directory) } finally { await lease.release() }
    }
  }

  const pairingCodeStatus = async (directory: string): Promise<PairingCodeView> => {
    let pending = await loadPairingCode(directory)
    if (!pending) {
      const state = await existingState(directory)
      return state ? connectedView(state) : { status: 'idle' }
    }
    if (!pending.response) pending = await mint(directory, pending)
    await clearRetiredState(directory, pending)
    // The person's claim in Nessie is the whole pairing: the poll that first
    // reads `confirmed` saves this machine's connection, and nothing here asks.
    const result = await poll(pending)
    if (result.status === 'confirmed' && result.claim) await complete(directory, pending, result.claim)
    if (result.status === 'rejected') await clearPairingCode(directory)
    return {
      status: result.status === 'confirmed' ? 'paired' : result.status === 'rejected' ? 'cancelled' : result.status,
      code: pending.response?.code, expiresAt: result.expiresAt, fingerprint: result.fingerprint,
      apiBaseUrl: pending.apiBaseUrl, machineName: pending.request.machineName,
      ...(result.claim ? labels(result.claim) : {}),
    }
  }

  const cancelPairingCode = async (directory: string): Promise<PairingCodeView> => {
    let pending = await loadPairingCode(directory)
    if (pending && !pending.response) pending = await mint(directory, pending)
    if (pending) await clearRetiredState(directory, pending)
    if (pending?.response) {
      const payload = { pairingId: pending.response.pairingId, timestamp: new Date().toISOString() }
      await postPairing(pending.apiBaseUrl, 'cancel', {
        ...payload, signature: pairingSignature(pending.machinePrivateKey, 'cancel', payload),
      })
    }
    await clearPairingCode(directory)
    return { status: 'cancelled' }
  }

  const locked = async <T>(directory: string, action: () => Promise<T>): Promise<T> => {
    const lease = await acquirePairingLease(directory)
    try { return await action() } finally { await lease.release() }
  }
  return {
    startPairingCode: (input: Parameters<typeof startPairingCode>[0]) => (
      locked(input.stateDir, () => startPairingCode(input))
    ),
    pairingCodeStatus: (directory: string) => locked(directory, () => pairingCodeStatus(directory)),
    cancelPairingCode: (directory: string) => locked(directory, () => cancelPairingCode(directory)),
  }
}

export const { startPairingCode, pairingCodeStatus, cancelPairingCode } = createPairingCodeClient()
