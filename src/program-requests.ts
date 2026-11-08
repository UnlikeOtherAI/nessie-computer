import { randomUUID } from 'node:crypto'
import { link, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory, secureOwnerOnlyStateFile } from './state-security.js'

/**
 * Program requests: a launch an agent asked for that this team's rules do not
 * allow yet, waiting for the computer's owner (`program-request-gate.ts`).
 *
 * They live in `program-requests/` beside the team's state, which is
 * owner-only, so only the owner can read or answer one. Each request is two
 * files with one writer each: the daemon writes `<id>.json` and removes both
 * when the wait ends; the owner's `program-request answer` writes
 * `<id>.answer.json` once. A request exists only while a daemon holds its
 * launch, so a daemon starting up removes whatever an earlier one left.
 */
export type ProgramRequest = {
  id: string
  program: string
  args: string[]
  requestedAt: string
  /** When the daemon stops waiting and refuses the launch. */
  expiresAt: string
}

export type ProgramRequestAnswer = 'once' | 'always' | 'deny'
export const PROGRAM_REQUEST_ANSWERS: readonly ProgramRequestAnswer[] = ['once', 'always', 'deny']

export const PROGRAM_REQUESTS_DIRECTORY = 'program-requests'

/** Why the owner's answer could not be taken; `code` is what the apps key their words on. */
export class ProgramRequestError extends Error {
  constructor(
    readonly code: 'PROGRAM_REQUEST_ID_INVALID' | 'PROGRAM_REQUEST_NOT_WAITING' | 'PROGRAM_REQUEST_ALREADY_ANSWERED'
      | 'PROGRAM_REQUEST_RULE_NOT_SAVED',
    message: string,
  ) {
    super(message)
    this.name = 'ProgramRequestError'
  }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const directoryOf = (stateDir: string): string => join(stateDir, PROGRAM_REQUESTS_DIRECTORY)
const requestPath = (stateDir: string, id: string): string => join(directoryOf(stateDir), `${id}.json`)
const answerPath = (stateDir: string, id: string): string => join(directoryOf(stateDir), `${id}.answer.json`)

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

const removeIfPresent = (path: string): Promise<void> =>
  unlink(path).catch((error: unknown) => { if (!missing(error)) throw error })

const parseRequest = (value: unknown, id: string): ProgramRequest | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.id !== id || typeof record.program !== 'string' || !Array.isArray(record.args)
    || record.args.some((arg) => typeof arg !== 'string')
    || typeof record.requestedAt !== 'string' || typeof record.expiresAt !== 'string'
    || Number.isNaN(Date.parse(record.expiresAt))) return null
  return {
    id, program: record.program, args: record.args as string[],
    requestedAt: record.requestedAt, expiresAt: record.expiresAt,
  }
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    await assertOwnerOnlyStatePath(path, 'file')
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (missing(error)) return undefined
    return null
  }
}

/** The daemon's side: one store for the daemon's whole life. */
export const openProgramRequestStore = (stateDir: string) => ({
  /** Removes every request an earlier daemon left; none of their launches is still held. */
  sweep: async (): Promise<void> => {
    const directory = await ensureOwnerOnlyStateDirectory(directoryOf(stateDir))
    for (const name of await readdir(directory)) {
      // `.new` is an answer an interrupted `program-request answer` never published.
      if (/\.(?:json|new)$/u.test(name)) await removeIfPresent(join(directory, name))
    }
  },
  create: async (request: ProgramRequest): Promise<void> => {
    await ensureOwnerOnlyStateDirectory(directoryOf(stateDir))
    await replaceOwnerOnlyJson(requestPath(stateDir, request.id), request)
  },
  /** The owner's answer, once there is one; anything unreadable is no answer. */
  answer: async (id: string): Promise<ProgramRequestAnswer | null> => {
    const value = await readJson(answerPath(stateDir, id))
    const answer = (value as { id?: unknown; answer?: unknown } | null | undefined)
    return answer?.id === id && PROGRAM_REQUEST_ANSWERS.includes(answer.answer as ProgramRequestAnswer)
      ? answer.answer as ProgramRequestAnswer : null
  },
  remove: async (id: string): Promise<void> => {
    await removeIfPresent(requestPath(stateDir, id))
    await removeIfPresent(answerPath(stateDir, id))
  },
})

export type ProgramRequestStore = ReturnType<typeof openProgramRequestStore>

/** The requests still waiting for the owner: not yet answered and not yet expired, oldest first. */
export const listProgramRequests = async (
  stateDir: string, now: Date = new Date(),
): Promise<ProgramRequest[]> => {
  let names: string[]
  try {
    await assertOwnerOnlyStatePath(directoryOf(stateDir), 'directory')
    names = await readdir(directoryOf(stateDir))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const requests: ProgramRequest[] = []
  for (const name of names) {
    const id = name.replace(/\.json$/u, '')
    if (!ID.test(id)) continue
    if (names.includes(`${id}.answer.json`)) continue
    const request = parseRequest(await readJson(join(directoryOf(stateDir), name)), id)
    if (request && Date.parse(request.expiresAt) > now.getTime()) requests.push(request)
  }
  return requests.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
}

/**
 * The one request `id` names, still waiting, or an error that says why it
 * cannot be answered. An id is checked before it becomes part of a path.
 */
export const waitingProgramRequest = async (
  stateDir: string, id: string, now: Date = new Date(),
): Promise<ProgramRequest> => {
  if (!ID.test(id)) {
    throw new ProgramRequestError('PROGRAM_REQUEST_ID_INVALID', 'A program request id is the id that program-requests lists.')
  }
  const request = (await listProgramRequests(stateDir, now)).find((candidate) => candidate.id === id)
  if (!request) {
    throw new ProgramRequestError('PROGRAM_REQUEST_NOT_WAITING',
      'That program request is no longer waiting: it was answered, it expired, or the team stopped.')
  }
  return request
}

/**
 * Writes the owner's answer once; a second answer to the same request is
 * refused. The answer is written and secured under a temporary name first and
 * then published by a hard link, which fails when an answer is already there:
 * the daemon reads an answer the moment it appears and removes it with its
 * request, so a file it could see half written, or before it was secured,
 * would be lost to it.
 */
export const writeProgramRequestAnswer = async (
  stateDir: string, id: string, answer: ProgramRequestAnswer, now: Date = new Date(),
): Promise<void> => {
  const path = answerPath(stateDir, id)
  const temporary = `${path}.${process.pid}.${randomUUID()}.new`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ id, answer, answeredAt: now.toISOString() })}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await secureOwnerOnlyStateFile(temporary)
    await link(temporary, path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new ProgramRequestError('PROGRAM_REQUEST_ALREADY_ANSWERED', 'That program request was already answered.')
    })
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
