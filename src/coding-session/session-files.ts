import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureOwnerOnlyStateDirectory } from '../state-security.js'
import { CODING_SESSION_ID_PATTERN } from './types.js'

/**
 * The on-disk layout of one coding-sessions state directory, and the few file
 * primitives every writer uses.
 *
 *   <stateDir>/commands/<commandId>.json   the first outcome of each executor command
 *   <stateDir>/agent-help.json             what each installed CLI's --help offers, per program and mtime
 *   <stateDir>/sessions/<id>/meta.json     bridge-written once
 *   <stateDir>/sessions/<id>/session.json  host-written, debounced
 *   <stateDir>/sessions/<id>/events.jsonl  host-written, rotated at 16 MiB
 *   <stateDir>/sessions/<id>/inbox/        bridge requests, one file per command
 *   <stateDir>/sessions/<id>/host.lock     the live host's heartbeat
 *   <stateDir>/sessions/<id>/host.log      the host's stdout/stderr, bounded
 *   <stateDir>/sessions/<id>/agent-stderr.log
 */
export type CodingSessionPaths = {
  dir: string
  meta: string
  state: string
  events: string
  previousEvents: string
  inbox: string
  lock: string
  hostLog: string
  agentStderr: string
  delivered: string
  spawnMarker: string
}

export const codingCommandsDir = (stateDir: string): string => join(stateDir, 'commands')
export const codingAgentHelpCache = (stateDir: string): string => join(stateDir, 'agent-help.json')
export const codingSessionsDir = (stateDir: string): string => join(stateDir, 'sessions')

export const codingSessionPaths = (stateDir: string, sessionId: string): CodingSessionPaths => {
  // A session id is always one we minted; anything else never reaches a path join.
  if (!CODING_SESSION_ID_PATTERN.test(sessionId)) throw new Error('A coding session id is a lowercase UUID.')
  const dir = join(codingSessionsDir(stateDir), sessionId)
  return {
    dir,
    meta: join(dir, 'meta.json'),
    state: join(dir, 'session.json'),
    events: join(dir, 'events.jsonl'),
    previousEvents: join(dir, 'events.previous.jsonl'),
    inbox: join(dir, 'inbox'),
    lock: join(dir, 'host.lock'),
    hostLog: join(dir, 'host.log'),
    agentStderr: join(dir, 'agent-stderr.log'),
    delivered: join(dir, 'delivered.json'),
    spawnMarker: join(dir, 'spawn.json'),
  }
}

/**
 * Owner-only on POSIX (0700). On Windows a packaged runtime applies the
 * native helper's explicit DACL, as the executor's own state does; a
 * development run has no helper, so the directory inherits the DACL of the
 * executor state directory it is created in.
 */
export const ensureCodingStateDir = async (path: string): Promise<void> => {
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
    await ensureOwnerOnlyStateDirectory(path)
    return
  }
  await mkdir(path, { recursive: true })
}

export const ensurePrivateDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

const RETRIED_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_RETRY_MS = 2_000

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

/**
 * A rename that rides out Windows: a file an indexer, scanner or editor holds
 * open without FILE_SHARE_DELETE fails with EPERM, EACCES or EBUSY for a
 * moment, so those are retried for up to two seconds.
 */
export const renameWithRetry = async (from: string, to: string): Promise<void> => {
  const deadline = Date.now() + RENAME_RETRY_MS
  for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!RETRIED_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error
      await delay(wait)
    }
  }
}

/** Replaces `path` atomically, through a temporary file and `renameWithRetry`. */
export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** Creates `path` only if it does not exist; `false` means somebody already did. */
export const createJsonExclusive = async (path: string, value: unknown): Promise<boolean> => {
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return true
}

export const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export type JsonRead<T> = { found: 'yes'; value: T } | { found: 'no' } | { found: 'unreadable' }

const READ_RETRY_MS = 1_000

/**
 * A read that tells a missing file from one it could not read. A Windows
 * scanner or backup tool holds a file for a moment (EPERM, EBUSY, EACCES), and
 * a file created with `wx` is empty until its writer has written it, so those
 * are read again for about a second before the file counts as unreadable.
 * Only ENOENT is "no such file": a host that took a transient error for that
 * would reset its session or think its lock was taken over.
 */
export const readJsonFile = async <T>(path: string): Promise<JsonRead<T>> => {
  const deadline = Date.now() + READ_RETRY_MS
  for (let wait = 25; ; wait = Math.min(wait * 2, 200)) {
    try {
      return { found: 'yes', value: JSON.parse(await readFile(path, 'utf8')) as T }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: 'no' }
      if (Date.now() >= deadline) return { found: 'unreadable' }
      await delay(wait)
    }
  }
}

/** `readJsonFile` for readers that only need the value: absent and unreadable are both `undefined`. */
export const readJsonPatiently = async <T>(path: string): Promise<T | undefined> => {
  const read = await readJsonFile<T>(path)
  return read.found === 'yes' ? read.value : undefined
}

/** Keeps a log to about `maxBytes` by moving it aside once it grows past that. */
export const rotateLogIfLarge = async (path: string, maxBytes: number): Promise<void> => {
  const size = await stat(path).then((info) => info.size, () => 0)
  if (size > maxBytes) await rename(path, `${path}.1`).catch(() => undefined)
}

/**
 * A debounced writer for the host's `session.json`: at most one write per
 * 500 ms, the latest state always wins, and a failed write is logged rather
 * than fatal — the next change rewrites the whole file anyway.
 *
 * `mayWrite` is asked before every write. A host whose lock another host has
 * taken over answers `false`, and from then on writes nothing: a host that
 * lost a takeover race would otherwise overwrite the winner's state — its
 * freshly recorded agent identity among it.
 */
export const createDebouncedJsonWriter = (
  path: string, current: () => unknown, log: (message: string) => void, intervalMs = 500,
  mayWrite: () => Promise<boolean> = async () => true,
) => {
  let timer: NodeJS.Timeout | undefined
  let lastWrite = 0
  let writing: Promise<void> = Promise.resolve()
  let refused = false
  const write = (): Promise<void> => {
    timer = undefined
    lastWrite = Date.now()
    writing = writing.then(async () => {
      if (refused || !await mayWrite()) {
        if (!refused) log('session state not written: another host owns the session')
        refused = true
        return
      }
      await writeJsonAtomic(path, current())
    }).catch((error: unknown) => {
      log(`session state write failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return writing
  }
  return {
    schedule: (): void => {
      if (timer) return
      timer = setTimeout(() => { void write() }, Math.max(0, lastWrite + intervalMs - Date.now()))
    },
    flush: async (): Promise<void> => {
      clearTimeout(timer)
      await write()
    },
  }
}
