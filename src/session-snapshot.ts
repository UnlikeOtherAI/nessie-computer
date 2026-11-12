import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * What the team's daemon is working on, for the owner's "Now working" list
 * (contract §11.5, `docs/sessions-and-concurrency.md`). The running daemon
 * replaces `sessions.json` in the team's owner-only state directory whenever a
 * command arrives, starts, waits or ends; `sessions --json` reads it. A file
 * whose daemon is no longer alive says nothing, so it reads as no sessions.
 */
export type SessionCommandStatus = 'running' | 'queued' | 'waiting_for_owner'

/**
 * One command, in the words the console needs (`packages/executor-console`
 * README, "Host commands"): what kind of work, its status, and what it works
 * on. `requestId` is the program request a `waiting_for_owner` command waits
 * on, as `program-requests` lists it.
 */
export type SessionCommandView = {
  id: string
  kind: 'program' | 'file' | 'coding' | 'browser' | 'mcp'
  status: SessionCommandStatus
  program?: string
  args?: string[]
  operation?: 'read' | 'write'
  path?: string
  site?: string
  app?: string
  requestId?: string
}

/**
 * A session with work on this computer. `sessionId` is Nessie's session, or
 * the run's id for commands from a Nessie that sends no session.
 */
export type SessionView = {
  sessionId: string
  agentName?: string
  startedAt: string
  commands: SessionCommandView[]
}

type SessionsFile = { version: 1; daemonPid: number; updatedAt: string; sessions: SessionView[] }

export const SESSIONS_FILE = 'sessions.json'

export const sessionsPath = (stateDir: string): string => join(stateDir, SESSIONS_FILE)

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** As in the daemon lease: only `ESRCH` proves a process is gone. */
const processIsLive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export const writeSessionsFile = (
  stateDir: string, sessions: readonly SessionView[], now: () => Date = () => new Date(),
): Promise<void> => replaceOwnerOnlyJson(sessionsPath(stateDir), {
  version: 1, daemonPid: process.pid, updatedAt: now().toISOString(), sessions: [...sessions],
} satisfies SessionsFile)

export const removeSessionsFile = (stateDir: string): Promise<void> =>
  unlink(sessionsPath(stateDir)).catch((error: unknown) => { if (!missing(error)) throw error })

const isSessionsFile = (value: unknown): value is SessionsFile => {
  const file = value as Partial<SessionsFile> | null
  return Boolean(file) && file!.version === 1 && Number.isSafeInteger(file!.daemonPid) && file!.daemonPid! > 0
    && Array.isArray(file!.sessions)
}

/** The sessions the team's running daemon reports; none when it is not running. */
export const readSessions = async (
  stateDir: string, isLive: (pid: number) => boolean = processIsLive,
): Promise<SessionView[]> => {
  const path = sessionsPath(stateDir)
  let value: unknown
  try {
    await assertOwnerOnlyStatePath(path, 'file')
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return []
    throw error
  }
  if (!isSessionsFile(value) || !isLive(value.daemonPid)) return []
  return value.sessions
}
