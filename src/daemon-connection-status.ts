import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceOwnerOnlyText } from './owner-only-json.js'
import { executorProcessLeaseState } from './process-lease.js'

const marker = (directory: string) => join(directory, 'daemon-connecting')

/** Display only. The daemon holding the team's lease owns the marker. */
export const teamIsConnecting = async (directory: string): Promise<boolean> => {
  try {
    return (await lstat(marker(directory))).isFile() && await executorProcessLeaseState(directory, 'daemon.pid') === 'live'
  } catch { return false }
}

export const createConnectionStatusWriter = (directory: string) => {
  let saved: boolean | undefined
  return async (connecting: boolean): Promise<void> => {
    if (saved === connecting) return
    try {
      if (connecting) await replaceOwnerOnlyText(marker(directory), '')
      else await unlink(marker(directory)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      saved = connecting
    } catch {
      // Retry on the next heartbeat. A display failure must never interrupt the connection.
    }
  }
}
