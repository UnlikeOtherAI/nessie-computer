import { readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  ExecutorPairingStartRequestSchema,
  ExecutorPairingStartResponseSchema,
  type ExecutorPairingStartRequest,
  type ExecutorPairingStartResponse,
} from '@nessie/executor-protocol'

import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'
import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertExecutorWorkspaceFolders, type ExecutorWorkspaceFolder } from './workspace-folders.js'

/** Only machine material lives here. Organisation/team names are always read live. */
export type PendingPairingCode = {
  apiBaseUrl: string
  machinePrivateKey: string
  request: ExecutorPairingStartRequest
  response?: ExecutorPairingStartResponse
  workspaceFolders: ExecutorWorkspaceFolder[]
}

const pairingPath = (directory: string): string => resolve(directory, 'executor-pairing-code.json')

export const loadPairingCode = async (directory: string): Promise<PendingPairingCode | null> => {
  await ensureOwnerOnlyStateDirectory(directory)
  const path = pairingPath(directory)
  try {
    await assertOwnerOnlyStatePath(path, 'file')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PendingPairingCode>
    if (typeof parsed.apiBaseUrl !== 'string' || typeof parsed.machinePrivateKey !== 'string'
      || !Array.isArray(parsed.workspaceFolders)) throw new Error('Pairing could not be restored.')
    assertExecutorWorkspaceFolders(parsed.workspaceFolders)
    return {
      apiBaseUrl: parsed.apiBaseUrl,
      machinePrivateKey: parsed.machinePrivateKey,
      request: ExecutorPairingStartRequestSchema.parse(parsed.request),
      ...(parsed.response ? { response: ExecutorPairingStartResponseSchema.parse(parsed.response) } : {}),
      workspaceFolders: parsed.workspaceFolders,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const savePairingCode = async (directory: string, pending: PendingPairingCode): Promise<void> => {
  await ensureOwnerOnlyStateDirectory(directory)
  await replaceOwnerOnlyJson(pairingPath(directory), pending)
}

export const clearPairingCode = async (directory: string): Promise<void> => {
  try {
    await assertOwnerOnlyStatePath(pairingPath(directory), 'file')
    await unlink(pairingPath(directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
