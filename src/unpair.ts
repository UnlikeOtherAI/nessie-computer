import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { parse, resolve } from 'node:path'

import { executorApi } from './api-client.js'
import { acquireExecutorDaemonLease } from './daemon-lease.js'
import { pairingSignature } from './pairing-code.js'
import { loadExecutorState } from './state-store.js'
import { acquireChatgptPairingRetirement } from './chatgpt-pairing-retirement.js'

export type UnpairResult = { status: 'removed'; signedOff: boolean }

const unpairDependencies = {
  acquireExecutorDaemonLease,
  loadExecutorState,
  acquireChatgptPairingRetirement,
  signOff: (origin: string, body: unknown) => executorApi.pairing(origin, 'sign-off', body),
  remove: (directory: string) => rm(directory, { recursive: true, force: true }),
  report: (message: string) => { process.stderr.write(message) },
}

/**
 * Removes one team's connection from this computer: its machine key, local
 * permissions, settings and any draft copies not yet applied. The key signs a
 * last "signing off" message first, so Nessie shows the computer as
 * Disconnected straight away. If Nessie cannot be reached the removal still
 * happens — the person asked for it — and the result says so; Nessie then
 * shows the computer as Offline until someone removes it there.
 *
 * Only a directory holding a readable executor state is removed, and never
 * the home directory or a filesystem root, whatever `--state-dir` says.
 */
export const createUnpair = (overrides: Partial<typeof unpairDependencies> = {}) => {
  const { acquireExecutorDaemonLease, loadExecutorState, acquireChatgptPairingRetirement, signOff, remove, report } = {
    ...unpairDependencies, ...overrides,
  }
  return async (stateDir: string): Promise<UnpairResult> => {
    const directory = resolve(stateDir)
    if (directory === resolve(homedir()) || directory === parse(directory).root) {
      throw new Error('This folder is not an executor connection, so it was not removed.')
    }
    const lease = await acquireExecutorDaemonLease(directory).catch((error: unknown) => {
      if ((error as Error).message === 'EXECUTOR_DAEMON_ALREADY_RUNNING') {
        throw new Error('This connection is running. Stop it first, then remove it.')
      }
      throw error
    })
    let signedOff = false
    let personal: Awaited<ReturnType<typeof acquireChatgptPairingRetirement>> | undefined
    try {
      const state = await loadExecutorState(directory)
      personal = await acquireChatgptPairingRetirement(new URL(state.apiBaseUrl).origin, state.executorId)
      const payload = { executorId: state.executorId, timestamp: new Date().toISOString() }
      try {
        await signOff(state.apiBaseUrl, {
          ...payload, signature: pairingSignature(state.machinePrivateKey, 'sign-off', payload),
        })
        signedOff = true
      } catch (error) {
        report(`Nessie was not told that this computer signed off (${(error as Error).message}). `
          + 'It will show the computer as offline until someone removes it there.\n')
      }
      // Removed while the lease is held, so no daemon can start in between.
      await remove(directory)
    } finally {
      try { await personal?.release() } finally { await lease.release() }
    }
    return { status: 'removed', signedOff }
  }
}

export const unpairExecutor = createUnpair()
