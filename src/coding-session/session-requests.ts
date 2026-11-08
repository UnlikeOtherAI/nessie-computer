import type { SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'
import { link, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ensurePrivateDir,
  codingCommandsDir,
  codingSessionsDir,
  createJsonExclusive,
  readJson,
  type CodingSessionPaths,
} from './session-files.js'
import { CODING_SESSION_ID_PATTERN, type CodingSessionMeta, type CodingSessionRequest } from './types.js'

/**
 * Requests from the bridge to a host, and the record that makes every
 * executor command act at most once.
 *
 * A request lands in `inbox/` whole or not at all: it is written beside the
 * inbox and hard-linked in under its command id, which fails if that name is
 * already there. The host deletes a request once it has acted on it, so the
 * inbox alone cannot recognise a replay that arrives later; `commands/` can.
 * The first call for an executor command id records its outcome there, and
 * every later call with that id returns the recorded outcome and does nothing.
 */

export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

export type CommandRecord = {
  commandId: string
  ownerKey: string
  tool: string
  sessionId: string
  at: string
}

/** `undefined` when this is the first time; otherwise the outcome recorded the first time. */
export const claimCommand = async (stateDir: string, record: CommandRecord, effect?: SessionEffectAuthority): Promise<CommandRecord | undefined> => {
  if (!COMMAND_ID_PATTERN.test(record.commandId)) throw new Error('An executor command id is 1 to 128 letters, digits, - or _.')
  const path = join(codingCommandsDir(stateDir), `${record.commandId}.json`)
  if (await createJsonExclusive(path, record, effect)) return undefined
  return await readJson<CommandRecord>(path) ?? record
}

/** Command records only guard replays, which arrive within minutes; a week is generous. */
export const pruneCommandRecords = async (stateDir: string, maxAgeMs = 7 * 24 * 60 * 60 * 1_000): Promise<void> => {
  const dir = codingCommandsDir(stateDir)
  const names = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  for (const name of names.slice(0, 2_000)) {
    const path = join(dir, name)
    const age = await stat(path).then((info) => now - info.mtimeMs, () => 0)
    if (age > maxAgeMs) await unlink(path).catch(() => undefined)
  }
}

export const writeRequest = async (paths: CodingSessionPaths, request: CodingSessionRequest, effect?: SessionEffectAuthority): Promise<boolean> => {
  if (!COMMAND_ID_PATTERN.test(request.id)) throw new Error('A request id is 1 to 128 letters, digits, - or _.')
  const intents = join(paths.dir, 'request-intents')
  if (effect) await ensurePrivateDir(intents)
  const temporary = effect ? join(intents, `${request.id}.json`) : join(paths.dir, `.request-${randomUUID()}.tmp`)
  await effect?.consume()
  effect?.assertLive()
  const retained = effect ? { ...request, sessionAuthority: effect.scope } : request
  await writeFile(temporary, `${JSON.stringify(retained)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    await effect?.consume()
    effect?.assertLive()
    await link(temporary, join(paths.inbox, `${request.id}.json`))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    if (!effect) await unlink(temporary).catch(() => undefined)
  }
}

const validRequest = (value: unknown): value is CodingSessionRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return typeof request.id === 'string' && typeof request.at === 'string'
    && ['start', 'send', 'interrupt', 'close', 'retire', 'answer'].includes(request.kind as string)
    && (request.kind !== 'answer' || (!!request.answer && typeof request.answer === 'object'))
    && (request.text === undefined || typeof request.text === 'string')
    && (request.reason === undefined || typeof request.reason === 'string')
}

/** A file that cannot be a request is removed once it is old enough not to be a read that failed for a moment. */
const UNREADABLE_REQUEST_GRACE_MS = 5_000

/** Oldest first; the host acts on them in the order the bridge wrote them. */
export const listRequests = async (paths: CodingSessionPaths): Promise<CodingSessionRequest[]> => {
  const names = (await readdir(paths.inbox).catch(() => [] as string[])).filter((name) => name.endsWith('.json'))
  const requests: CodingSessionRequest[] = []
  for (const name of names) {
    const path = join(paths.inbox, name)
    const value = await readJson<unknown>(path)
    if (validRequest(value) && `${value.id}.json` === name) {
      requests.push(value)
      continue
    }
    const age = await stat(path).then((info) => Date.now() - info.mtimeMs, () => 0)
    if (age > UNREADABLE_REQUEST_GRACE_MS) await unlink(path).catch(() => undefined)
  }
  return requests.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
}

export const removeRequest = async (paths: CodingSessionPaths, id: string): Promise<void> => {
  await unlink(join(paths.inbox, `${id}.json`)).catch(() => undefined)
}

export const inboxHasRequests = async (paths: CodingSessionPaths): Promise<boolean> => (
  (await listRequests(paths)).length > 0
)

const validMeta = (value: unknown): value is CodingSessionMeta => {
  if (!value || typeof value !== 'object') return false
  const meta = value as Record<string, unknown>
  return meta.version === 1 && typeof meta.sessionId === 'string' && typeof meta.ownerKey === 'string'
    && (meta.agent === 'claude' || meta.agent === 'codex' || meta.agent === 'terminal') && typeof meta.rootName === 'string'
    && typeof meta.path === 'string' && typeof meta.title === 'string' && typeof meta.createdAt === 'string'
    && (meta.command === undefined || (Array.isArray(meta.command) && meta.command.every((arg) => typeof arg === 'string')))
    && (meta.cwd === undefined || typeof meta.cwd === 'string')
}

export const readSessionMeta = async (paths: CodingSessionPaths): Promise<CodingSessionMeta | undefined> => {
  const value = await readJson<unknown>(paths.meta)
  return validMeta(value) ? value : undefined
}

/** Every session directory's meta, for listing and quota; unreadable ones are skipped. */
export const listSessionMetas = async (stateDir: string): Promise<CodingSessionMeta[]> => {
  const names = await readdir(codingSessionsDir(stateDir)).catch(() => [] as string[])
  const metas: CodingSessionMeta[] = []
  for (const name of names) {
    if (!CODING_SESSION_ID_PATTERN.test(name)) continue
    const meta = await readJson<unknown>(join(codingSessionsDir(stateDir), name, 'meta.json'))
    if (validMeta(meta) && meta.sessionId === name) metas.push(meta)
  }
  return metas
}
