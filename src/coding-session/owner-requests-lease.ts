import { join } from 'node:path'

import { readJson, writeJsonAtomic } from './session-files.js'

/**
 * Whether a session host may put a provider's prompt to its owner, as the
 * daemon last said: written into the bridge's state directory, renewed with
 * every heartbeat while it holds, and read by every host before it opens a
 * request. A lease nobody renews lapses within a minute, so a host whose
 * daemon stopped turns prompts down again rather than leaving them waiting on
 * nobody.
 *
 * The daemon grants it only while Nessie has shown, on the current
 * connection, that it reads requests (`owner-requests-gate.ts`), and the
 * reviewed facts say the owner answers prompts (`ownerAnswers`). Without it a
 * host turns every prompt down at once — the stance before a prompt could
 * reach the owner. It grants nothing: the owner still decides every request.
 */

const LEASE_MS = 60_000

type Lease = { expiresAt: number }

const pathOf = (stateDir: string): string => join(stateDir, 'owner-requests.json')

export const ownerRequestsLeaseIsLive = async (stateDir: string, now = Date.now()): Promise<boolean> => {
  const lease = await readJson<Lease>(pathOf(stateDir))
  return typeof lease?.expiresAt === 'number' && lease.expiresAt > now
}

/** Serialised writes of the lease: live renews it for a minute, not live ends it now. */
export const ownerRequestsLeaseWriter = (stateDir: string) => {
  let writes: Promise<void> = Promise.resolve()
  return (live: boolean): Promise<void> => {
    const lease: Lease = { expiresAt: live ? Date.now() + LEASE_MS : 0 }
    writes = writes.catch(() => undefined).then(() => writeJsonAtomic(pathOf(stateDir), lease))
    return writes
  }
}
