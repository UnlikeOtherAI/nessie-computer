import { lstat, readdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { loadExecutorState } from './state-store.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'
import { acquireExecutorProcessLease } from './process-lease.js'

const root = (): string => resolve(homedir(), '.local/state/nessie-executor')
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const acquireDefaultPairingLease = async () => (
  acquireExecutorProcessLease(await ensureOwnerOnlyStateDirectory(root()), 'pairing-operation.pid')
)

/** A new team gets its own key; replacement must name a team already on this computer. */
export const defaultPairingDirectory = async (executorId?: string): Promise<string> => {
  const directory = await ensureOwnerOnlyStateDirectory(root())
  if (executorId) {
    if (!/^[a-f0-9-]{36}$/i.test(executorId)) throw new Error('Choose a team id: nessie-computer teams shows them.')
    const selected = resolve(directory, executorId)
    if (!await loadExecutorState(selected)) throw new Error('That team isn\'t on this computer.')
    return selected
  }
  const pending: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9-]+$/.test(entry.name)) continue
    const child = resolve(directory, entry.name)
    if (await lstat(resolve(child, 'executor-pairing-code.json')).catch((error: unknown) => {
      if (absent(error)) return null
      throw error
    })) pending.push(child)
  }
  if (pending.length > 1) {
    throw new Error('Several Add this computer attempts are open. Finish or cancel one with --state-dir first.')
  }
  if (pending[0]) return pending[0]
  const staging = resolve(directory, 'pairing')
  const completed = await loadExecutorState(staging).catch((error: unknown) => {
    if (absent(error)) return null
    throw error
  })
  if (completed) await promoteDefaultPairing(staging, completed.executorId)
  return staging
}

/** systemd's fixed template resolves by executor id, assigned only after the claim. */
export const promoteDefaultPairing = async (directory: string, executorId: string): Promise<void> => {
  if (!/^[a-f0-9-]{36}$/i.test(executorId)) throw new Error('Nessie returned an invalid computer identity.')
  const destination = resolve(root(), executorId)
  if (directory === destination) return
  if (await lstat(destination).catch((error: unknown) => {
    if (absent(error)) return null
    throw error
  })) throw new Error('This computer is already in that team.')
  await rename(directory, destination)
}
