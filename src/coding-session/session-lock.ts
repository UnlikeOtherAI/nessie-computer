import { randomUUID } from 'node:crypto'
import { open, rename, stat, unlink } from 'node:fs/promises'

import { codingProcessIsAlive } from './process-control.js'
import { readJsonFile, readJsonPatiently, writeJsonAtomic } from './session-files.js'
import { CODING_SESSION_PROTOCOL_VERSION } from './types.js'

/**
 * One live host per session, proved by a heartbeat rather than by a pid.
 *
 * Pids are reused after a crash or a reboot, and a reused pid answers
 * `kill(pid, 0)` exactly as the dead host would have. So a lock is live only
 * while its heartbeat is fresh; a dead pid may make it stale sooner, but a
 * live one never keeps it alive. Takeover renames the stale lock aside and
 * creates a new one with `wx`, and every host re-reads the lock on each
 * heartbeat and immediately before it spawns an agent, exiting the moment the
 * token in it is not its own. Two hosts that race a takeover therefore end
 * with one survivor.
 */
export const HOST_HEARTBEAT_MS = 2_000
export const HOST_LOCK_STALE_MS = 10_000

export type HostLockRecord = {
  pid: number
  token: string
  protocolVersion: number
  runtimeDigest: string
  startedAt: string
  heartbeatAt: string
}

export type HeldHostLock = {
  record: HostLockRecord
  /** Rewrites the heartbeat; `false` means the lock is no longer ours. */
  heartbeat: () => Promise<boolean>
  stillOurs: () => Promise<boolean>
  release: () => Promise<void>
}

const validLock = (value: unknown): value is HostLockRecord => {
  if (!value || typeof value !== 'object') return false
  const lock = value as Record<string, unknown>
  return Number.isSafeInteger(lock.pid) && typeof lock.token === 'string' && typeof lock.heartbeatAt === 'string'
    && typeof lock.startedAt === 'string' && typeof lock.protocolVersion === 'number' && typeof lock.runtimeDigest === 'string'
}

export const readHostLock = async (path: string): Promise<HostLockRecord | undefined> => {
  const value = await readJsonPatiently<unknown>(path)
  return validLock(value) ? value : undefined
}

export const hostLockIsStale = (lock: HostLockRecord, now = Date.now()): boolean => {
  const heartbeat = Date.parse(lock.heartbeatAt)
  return !Number.isFinite(heartbeat) || now - heartbeat > HOST_LOCK_STALE_MS || !codingProcessIsAlive(lock.pid)
}

const createLock = async (path: string, record: HostLockRecord): Promise<boolean> => {
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return true
}

export const acquireHostLock = async (path: string, runtimeDigest: string): Promise<HeldHostLock | undefined> => {
  const now = new Date().toISOString()
  const record: HostLockRecord = {
    pid: process.pid,
    token: randomUUID(),
    protocolVersion: CODING_SESSION_PROTOCOL_VERSION,
    runtimeDigest,
    startedAt: now,
    heartbeatAt: now,
  }
  let created = false
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    created = await createLock(path, record)
    if (created) break
    const existing = await readHostLock(path)
    if (existing && !hostLockIsStale(existing)) return undefined
    if (!existing) {
      // Unreadable: possibly a lock another host created a moment ago and is still writing.
      const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => undefined)
      if (age === undefined) continue
      if (age < HOST_LOCK_STALE_MS) return undefined
    }
    const aside = `${path}.stale.${randomUUID()}`
    await rename(path, aside).then(() => unlink(aside).catch(() => undefined), () => undefined)
  }
  if (!created) return undefined
  // Gone, or a lock with another token, is a takeover. A lock a scanner holds
  // past the read's own retries is not: the next heartbeat looks again.
  const stillOurs = async (): Promise<boolean> => {
    const read = await readJsonFile<unknown>(path)
    if (read.found === 'unreadable') return true
    return read.found === 'yes' && validLock(read.value) && read.value.token === record.token
  }
  return {
    record,
    stillOurs,
    heartbeat: async () => {
      if (!await stillOurs()) return false
      record.heartbeatAt = new Date().toISOString()
      await writeJsonAtomic(path, record)
      return true
    },
    release: async () => {
      if (await stillOurs()) await unlink(path).catch(() => undefined)
    },
  }
}
