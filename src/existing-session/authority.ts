import { join } from 'node:path'

import { readJson, writeJsonAtomic } from '../coding-session/session-files.js'

type Authority = { expiresAt: number }
const pathOf = (stateDir: string): string => join(stateDir, 'existing-session-authority.json')

/** A local receipt of the existing daemon heartbeat, not a second authorization or user grant. */
export const existingAuthorityIsLive = async (stateDir: string): Promise<boolean> => {
  const value = await readJson<Authority>(pathOf(stateDir))
  return typeof value?.expiresAt === 'number' && value.expiresAt > Date.now()
}

export const existingAuthorityWriter = (stateDir: string) => {
  let writes: Promise<void> = Promise.resolve()
  return (live: boolean): Promise<void> => {
    const value = { expiresAt: live ? Date.now() + 60_000 : 0 }
    writes = writes.catch(() => undefined).then(() => writeJsonAtomic(pathOf(stateDir), value))
    return writes
  }
}
