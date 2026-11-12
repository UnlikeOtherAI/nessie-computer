import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { canonicalExecutorJson, canonicalExecutorPayload, ExecutorEnrollmentRequestSchema,
  type ExecutorEnrollmentRequest } from '@nessie/executor-protocol'

import { executorApi } from './api-client.js'
import { pairedLocalCommandPolicy } from './command-policy.js'
import { pairedLocalMcpPolicy } from './mcp-policy.js'
import { buildSignedDescriptor } from './descriptor.js'
import { clearExecutorPreparedPairing, loadExecutorPreparedPairing, saveExecutorPreparedPairing,
  saveExecutorState, type ExecutorLocalState, type ExecutorPreparedPairing } from './state-store.js'
import { executorWorkspaceFolderNames, type ExecutorWorkspaceFolder } from './workspace-folders.js'

export type PairExecutorInput = {
  apiBaseUrl: string
  challenge: string
  enrollmentId: string
  stateDir: string
  workspaceFolders: readonly ExecutorWorkspaceFolder[]
  /** The Windows service retains the exact request until directory promotion succeeds. */
  retainPrepared?: boolean
}
export type PairExecutorDependencies = {
  clearPrepared: (stateDir: string) => Promise<void>
  loadPrepared: (stateDir: string) => Promise<ExecutorPreparedPairing | null>
  savePrepared: (stateDir: string, prepared: ExecutorPreparedPairing) => Promise<void>
  saveState: (stateDir: string, state: ExecutorLocalState) => Promise<void>
  submitEnrollment: (baseUrl: string, request: ExecutorEnrollmentRequest) => Promise<{
    executorId: string; fingerprint: string;
  }>
}
const dependencies: PairExecutorDependencies = {
  clearPrepared: clearExecutorPreparedPairing, loadPrepared: loadExecutorPreparedPairing,
  savePrepared: saveExecutorPreparedPairing, saveState: saveExecutorState,
  submitEnrollment: executorApi.submitEnrollment,
}
const rawPublicKey = (key: KeyObject): string =>
  key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

const prepare = (
  input: PairExecutorInput, workspaceFolders: ExecutorWorkspaceFolder[], initialPolicy: ExecutorLocalState['descriptor'],
): ExecutorPreparedPairing => {
  const keys = generateKeyPairSync('ed25519')
  const machinePrivateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
  const machinePublicKey = rawPublicKey(keys.publicKey)
  const descriptor = buildSignedDescriptor(machinePrivateKey,
    { ...initialPolicy, workspaceFolders: executorWorkspaceFolderNames(workspaceFolders) })
  const digest = `sha256:${createHash('sha256').update(canonicalExecutorJson(descriptor.descriptor)).digest('hex')}`
  const request = ExecutorEnrollmentRequestSchema.parse({
    challenge: input.challenge, descriptor, enrollmentId: input.enrollmentId, machinePublicKey,
    proof: sign(null, Buffer.from(canonicalExecutorPayload('nessie.executor.enrollment.v1', {
      challenge: input.challenge, descriptorDigest: digest, enrollmentId: input.enrollmentId, machinePublicKey,
    })), keys.privateKey).toString('base64url'),
  })
  return { apiBaseUrl: input.apiBaseUrl, enrollmentId: input.enrollmentId,
    machinePrivateKey, request, workspaceFolders }
}

const assertMatching = (
  input: PairExecutorInput, workspaceFolders: readonly ExecutorWorkspaceFolder[], prepared: ExecutorPreparedPairing,
): void => {
  let storedPublicKey: string
  try {
    storedPublicKey = rawPublicKey(createPublicKey(createPrivateKey({
      format: 'der', key: Buffer.from(prepared.machinePrivateKey, 'base64url'), type: 'pkcs8',
    })))
  } catch { throw new Error('This team’s pairing state contains an invalid private key.') }
  if (prepared.apiBaseUrl !== input.apiBaseUrl || prepared.enrollmentId !== input.enrollmentId
    || prepared.request.enrollmentId !== prepared.enrollmentId || prepared.request.challenge !== input.challenge
    || prepared.request.machinePublicKey !== storedPublicKey
    || prepared.workspaceFolders.length !== workspaceFolders.length
    || prepared.workspaceFolders.some((folder, index) => folder.name !== workspaceFolders[index]?.name
      || folder.path !== workspaceFolders[index]?.path)) {
    throw new Error('This team’s folder contains a different unfinished pairing. Complete that pairing before starting another.')
  }
}

/** The same durable key and proof survive transport failures and service promotion retries. */
export const pairEnrollment = async (
  input: PairExecutorInput, workspaceFolders: ExecutorWorkspaceFolder[], initialPolicy: ExecutorLocalState['descriptor'],
  deps: PairExecutorDependencies = dependencies,
): Promise<{ fingerprint: string }> => {
  let prepared = await deps.loadPrepared(input.stateDir)
  if (prepared) assertMatching(input, workspaceFolders, prepared)
  else {
    prepared = prepare(input, workspaceFolders, initialPolicy)
    // Publish the exact private key and request before contacting the server.
    await deps.savePrepared(input.stateDir, prepared)
  }
  const pending = await deps.submitEnrollment(prepared.apiBaseUrl, prepared.request)
  await deps.saveState(input.stateDir, {
    apiBaseUrl: prepared.apiBaseUrl, commandPolicy: pairedLocalCommandPolicy(), mcpPolicy: pairedLocalMcpPolicy(),
    descriptor: { ...initialPolicy, workspaceFolders: executorWorkspaceFolderNames(prepared.workspaceFolders) },
    executorId: pending.executorId, machinePrivateKey: prepared.machinePrivateKey,
    machinePublicKey: prepared.request.machinePublicKey, workspaceFolders: prepared.workspaceFolders,
  })
  if (!input.retainPrepared) await deps.clearPrepared(input.stateDir)
  return { fingerprint: pending.fingerprint }
}
