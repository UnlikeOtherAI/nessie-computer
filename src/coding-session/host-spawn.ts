import { executorChildCommand } from '../executor-child-command.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { appendFile, open, readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'

import { reachableUserManager, startHostInUserUnit, type UnitRunner, type UserManager } from './host-unit.js'
import { createJsonExclusive, readJson, rotateLogIfLarge, writeJsonAtomic, type CodingSessionPaths } from './session-files.js'
import { hostLockIsStale, readHostLock } from './session-lock.js'
import { writeRequest } from './session-requests.js'
import { CODING_SESSION_PROTOCOL_VERSION } from './types.js'

/**
 * How the bridge makes sure a session has a live host, and starts one.
 *
 * The host is this same executor entry run as `coding-session-host`, with the
 * bridge's exec arguments and environment (so a development loader and the
 * packaged-CLI marker both survive), with its output in the session's bounded
 * `host.log`, in a systemd user unit of its own on Linux and detached
 * everywhere else. It outlives the bridge: the daemon's idle close, the
 * reporter's probe and a daemon restart all kill the bridge, and none of them
 * may take a coding turn with it.
 */

const ENTRY_NAMES = ['index.js', 'index.ts', 'nessie-executor.cjs']
const HOST_LOG_BYTES = 1024 * 1024
/** A host takes a second or three to start on Windows; the bridge does not start a second one meanwhile. */
const SPAWN_GRACE_MS = 15_000
/**
 * A host that is still running, in its unit or detached, has not failed, it is slow: a loaded machine can take
 * longer than the grace to load the executor. Another host is started only once that process has gone, or after
 * this long.
 */
const SLOW_START_LIMIT_MS = 120_000

export const resolveExecutorEntry = (invoked: string | undefined = process.argv[1]): string => {
  if (!invoked) throw new Error('Nessie Computer’s entry point is unknown.')
  const entry = realpathSync(invoked)
  if (!ENTRY_NAMES.includes(basename(entry))) {
    throw new Error('The coding-sessions bridge runs only from Nessie Computer’s entry point.')
  }
  return entry
}

const digests = new Map<string, Promise<string>>()

/** The running executor's own code, so a bridge can tell a host from an older install. */
export const executorRuntimeDigest = (entry: string): Promise<string> => {
  let digest = digests.get(entry)
  if (!digest) {
    digest = readFile(entry).then((bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    digests.set(entry, digest)
  }
  return digest
}

export type HostSpawnOptions = {
  userManager?: () => UserManager | undefined
  runUnit?: UnitRunner
}

/**
 * On Linux with a reachable user manager the host gets a systemd user unit of
 * its own (see `host-unit.ts`); everywhere else, and whenever that start is
 * refused, it is a detached process — its own session on POSIX, and on
 * Windows a process whose agent the native helper's Job Object contains.
 * Either way the answer names the host's process when it can, which is how a
 * host that is slow to start is told from one that has gone.
 */
export const spawnCodingSessionHost = async (input: {
  configPath: string
  entry: string
  paths: CodingSessionPaths
  sessionId: string
}, options: HostSpawnOptions = {}): Promise<{ mode: 'unit' | 'detached'; pid: number | undefined }> => {
  await rotateLogIfLarge(input.paths.hostLog, HOST_LOG_BYTES)
  const log = await open(input.paths.hostLog, 'a', 0o600)
  const argv = executorChildCommand({ execPath: process.execPath, execArgv: process.execArgv,
    entry: input.entry, packaged: process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1',
  }, ['coding-session-host', '--config', input.configPath, '--session', input.sessionId])
  const manager = (options.userManager ?? reachableUserManager)()
  if (manager) {
    await log.close()
    const started = await startHostInUserUnit({
      argv, hostLog: input.paths.hostLog, sessionId: input.sessionId, manager,
      ...(options.runUnit ? { run: options.runUnit } : {}),
    })
    if (started) return { mode: 'unit', pid: started.pid }
    // Said in the session's own log: a detached host shares the executor's cgroup, so an executor restart can stop it.
    await appendFile(input.paths.hostLog, `${new Date().toISOString()} systemd-run refused the unit; starting the host detached\n`)
      .catch(() => undefined)
    return spawnCodingSessionHost(input, { ...options, userManager: () => undefined })
  }
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      detached: true, env: process.env, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
    })
    await new Promise<void>((settle, fail) => {
      child.once('spawn', () => settle())
      child.once('error', fail)
    })
    child.unref()
    return { mode: 'detached', pid: child.pid }
  } finally {
    await log.close()
  }
}

/**
 * `spawn.json`: when the bridge last started a host for this session, and how
 * many hosts it has started since one last served a request. A host deletes it
 * once it has handled its first requests, so a host that dies before that —
 * a configuration it cannot load, a runtime that cannot start, a throw before
 * it serves — leaves the count climbing, and after `MAX_HOST_SPAWN_ATTEMPTS`
 * no more hosts are started for the requests already waiting: the session
 * reads `host_failed_to_start` instead of `starting` for ever. A new request
 * (a send, an interrupt, a close) gets fresh attempts of its own. `pid` is the
 * started host's process — the unit's main process, or the detached child —
 * which the bridge waits for past the grace while it still runs.
 */
type SpawnMarker = { at: number; attempts?: number; pid?: number }

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The last requested host may still take the lock: inside the grace, or while its own process still runs. */
const hostStillStarting = (marker: SpawnMarker, now = Date.now()): boolean => now - marker.at < SPAWN_GRACE_MS
  || (typeof marker.pid === 'number' && now - marker.at < SLOW_START_LIMIT_MS && processAlive(marker.pid))

export const MAX_HOST_SPAWN_ATTEMPTS = 3

export type HostAssurance = 'live' | 'starting' | 'spawned' | 'failed'

/**
 * A live host is left alone (and asked to retire after its turn when it runs
 * older code). Otherwise a host is spawned unless one was requested in the
 * last fifteen seconds and has not yet taken the lock — a second write in that
 * window would otherwise start a second host racing the first.
 */
export const ensureCodingSessionHost = async (input: {
  configPath: string
  entry: string
  paths: CodingSessionPaths
  sessionId: string
}, options: HostSpawnOptions & { fresh?: boolean } = {}): Promise<HostAssurance> => {
  const lock = await readHostLock(input.paths.lock)
  if (lock && !hostLockIsStale(lock)) {
    const digest = await executorRuntimeDigest(input.entry)
    if (lock.protocolVersion < CODING_SESSION_PROTOCOL_VERSION || lock.runtimeDigest !== digest) {
      await writeRequest(input.paths, { id: 'retire', kind: 'retire', at: new Date().toISOString() }).catch(() => false)
    }
    return 'live'
  }
  const marker = await readJson<SpawnMarker>(input.paths.spawnMarker)
  const now = Date.now()
  const requestedRecently = typeof marker?.at === 'number' && hostStillStarting(marker, now)
  const tookOver = lock !== undefined && typeof marker?.at === 'number' && Date.parse(lock.startedAt) >= marker.at
  if (requestedRecently && !tookOver) return 'starting'
  const attempts = options.fresh || typeof marker?.at !== 'number' ? 0 : marker.attempts ?? 1
  if (attempts >= MAX_HOST_SPAWN_ATTEMPTS) return 'failed'
  await unlink(input.paths.spawnMarker).catch(() => undefined)
  const next: SpawnMarker = { at: now, attempts: attempts + 1 }
  if (!await createJsonExclusive(input.paths.spawnMarker, next)) return 'starting'
  const spawned = await spawnCodingSessionHost(input, options)
  if (spawned.pid !== undefined) {
    // Only while the marker is still this spawn's: a host that already served deleted it.
    const current = await readJson<SpawnMarker>(input.paths.spawnMarker)
    if (current?.at === next.at) await writeJsonAtomic(input.paths.spawnMarker, { ...next, pid: spawned.pid })
  }
  return 'spawned'
}

/** The bridge gave up starting hosts for the requests waiting: every attempt died before it served one. */
export const codingHostSpawnFailed = async (paths: CodingSessionPaths): Promise<boolean> => {
  const marker = await readJson<SpawnMarker>(paths.spawnMarker)
  return typeof marker?.at === 'number' && (marker.attempts ?? 1) >= MAX_HOST_SPAWN_ATTEMPTS
    && !hostStillStarting(marker)
}

/** A host was asked for and has not had the time to take the lock yet. */
export const codingHostSpawnPending = async (paths: CodingSessionPaths): Promise<boolean> => {
  const marker = await readJson<SpawnMarker>(paths.spawnMarker)
  if (typeof marker?.at !== 'number' || !hostStillStarting(marker)) return false
  const lock = await readHostLock(paths.lock)
  return !lock || Date.parse(lock.startedAt) < marker.at
}
