import { readSessions, type SessionCommandView, type SessionView } from './session-snapshot.js'
import { isSessionId, requestSessionStop } from './session-stops.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * `sessions` and `session stop`: the owner's view of what agents are doing
 * on this computer, and the Stop for one session (contract §11.5,
 * `docs/sessions-and-concurrency.md`). Both work only on the team's own
 * owner-only state directory. The apps call them with `--json`; a failure
 * then prints `{ error: { code, message } }` and exits 1.
 */
export type SessionsCliCommand =
  | { json: boolean; kind: 'sessions'; stateDir: string }
  | { id: string; json: boolean; kind: 'session-stop'; stateDir: string }

export const SESSIONS_USAGE = '       nessie-executor sessions --state-dir <owner-only-path> [--json]\n'
  + '       nessie-executor session stop --state-dir <owner-only-path> --id <session-id> [--json]\n'

export class SessionCommandError extends Error {
  constructor(
    readonly code: 'SESSION_ID_INVALID' | 'SESSION_NOT_RUNNING' | 'EXECUTOR_STATE_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'SessionCommandError'
  }
}

/** How long `session stop` waits for the running team to end the session before it prints the list. */
const STOP_SETTLE_MS = 3_000
const STOP_CHECK_MS = 100

const value = (args: string[], name: string, usage: () => never): string => {
  const index = args.indexOf(name)
  const found = index >= 0 ? args[index + 1] : undefined
  return !found || found.startsWith('--') ? usage() : found
}

/** The command line for `sessions` or `session stop`, or `undefined` for any other verb. */
export const parseSessionsArguments = (args: string[], usage: () => never): SessionsCliCommand | undefined => {
  const json = args.includes('--json')
  if (args[0] === 'sessions') {
    if (args.length !== (json ? 4 : 3)) return usage()
    return { json, kind: 'sessions', stateDir: value(args, '--state-dir', usage) }
  }
  if (args[0] === 'session') {
    if (args[1] !== 'stop' || args.length !== (json ? 7 : 6)) return usage()
    return { id: value(args, '--id', usage), json, kind: 'session-stop', stateDir: value(args, '--state-dir', usage) }
  }
  return undefined
}

/** What one command is doing, in the console's words: "running `npm test`", "waiting for you: `docker build`". */
export const describeSessionCommand = (command: SessionCommandView): string => {
  const program = command.program && `\`${[command.program, ...command.args ?? []].join(' ')}\``
  const work = command.kind === 'program' ? program ?? 'a program'
    : command.kind === 'file' ? `${command.operation === 'write' ? 'writing' : 'reading'} ${command.path ?? 'files'}`
      : command.kind === 'browser' ? `browsing ${command.site ?? 'a website'}`
        : command.kind === 'mcp' ? `using ${command.app ?? 'a local app'}`
          : command.program ? `working in ${command.program}` : 'coding'
  if (command.status === 'queued') return `waiting to start: ${work}`
  if (command.status === 'waiting_for_owner') return `waiting for you: ${work}`
  return command.kind === 'program' ? `running ${work}` : work
}

/** One session and its commands as lines; `heading` names it. */
export const describeSession = (session: SessionView, heading: string): string =>
  `${heading}\n${session.commands.map((command) => `  ${describeSessionCommand(command)}`).join('\n')}\n`

const describe = (sessions: readonly SessionView[]): string => {
  if (sessions.length === 0) return 'No agent is working on this computer right now.\n'
  return sessions.map((session) => describeSession(session,
    `${session.agentName ?? 'An agent'} (session ${session.sessionId})`)).join('')
}

const readTeam = async (stateDir: string): Promise<SessionView[]> => {
  try {
    await assertOwnerOnlyStatePath(stateDir, 'directory')
  } catch (error) {
    throw new SessionCommandError('EXECUTOR_STATE_UNAVAILABLE', `This team's saved state could not be read: ${
      error instanceof Error ? error.message : String(error)}`)
  }
  return readSessions(stateDir)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

const run = async (command: SessionsCliCommand, write: (text: string) => void): Promise<void> => {
  if (command.kind === 'sessions') {
    const sessions = await readTeam(command.stateDir)
    write(command.json ? `${JSON.stringify(sessions)}\n` : describe(sessions))
    return
  }
  if (!isSessionId(command.id)) {
    throw new SessionCommandError('SESSION_ID_INVALID', 'A session id is the id that sessions lists.')
  }
  if (!(await readTeam(command.stateDir)).some((session) => session.sessionId === command.id)) {
    throw new SessionCommandError('SESSION_NOT_RUNNING', 'That session has no work on this computer now.')
  }
  const sessions = await stopTeamSession(command.stateDir, command.id)
  write(command.json ? `${JSON.stringify(sessions)}\n` : 'Stopped. The agent\'s work in that session ended on this computer.\n')
}

/**
 * Saves the owner's Stop for the team's running daemon and waits, briefly,
 * for it to end the session's work. Answers the team's list after that.
 */
export const stopTeamSession = async (stateDir: string, sessionId: string): Promise<SessionView[]> => {
  await requestSessionStop(stateDir, sessionId)
  let sessions = await readSessions(stateDir)
  for (let waited = 0; waited < STOP_SETTLE_MS && sessions.some((session) => session.sessionId === sessionId);
    waited += STOP_CHECK_MS) {
    await sleep(STOP_CHECK_MS)
    sessions = await readSessions(stateDir)
  }
  return sessions
}

/** Runs the verb; answers its exit code. */
export const runSessionsCommand = async (
  command: SessionsCliCommand, write: (text: string) => void,
): Promise<number> => {
  try {
    await run(command, write)
    return 0
  } catch (error) {
    if (!command.json) throw error
    const code = error instanceof SessionCommandError ? error.code : 'EXECUTOR_COMMAND_FAILED'
    write(`${JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } })}\n`)
    return 1
  }
}
