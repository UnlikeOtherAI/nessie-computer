import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, printJson } from './cli-output.js'
import { selectTeams, type LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { describeSession } from './session-cli.js'
import type { SessionView } from './session-snapshot.js'

/**
 * `sessions`: the Overview's Now working list — what agents are doing on this
 * computer, one session at a time — and its Stop, across every team. It reads
 * and stops through the same functions as the apps' `sessions` and
 * `session stop` (`session-cli.ts`).
 */

type TeamSession = SessionView & { team: LabelledTeam }

const SHORT_ID = 8

const sessionsOf = async (run: CliRun, teams: readonly LabelledTeam[]): Promise<TeamSession[]> => (await Promise.all(
  teams.map(async (team) => (await run.ops(team).sessions()).map((session) => ({ ...session, team })))))
  .flat().sort((left, right) => left.startedAt.localeCompare(right.startedAt))

const asJson = ({ team, ...session }: TeamSession) => ({ executorId: team.executorId, team: team.label, ...session })

const heading = (session: TeamSession): string =>
  `${session.agentName ?? 'An agent'} in ${session.team.label} (session ${session.sessionId.slice(0, SHORT_ID)})`

/** The one session an id names: the whole id, or a unique beginning of at least four characters. */
const findSession = (sessions: readonly TeamSession[], id: string): TeamSession => {
  const wanted = id.trim().toLowerCase()
  if (wanted.length < 4) throw new CliUsageError('Give at least the first four characters of the session id.', 'sessions')
  const matches = sessions.filter((session) => session.sessionId.startsWith(wanted))
  if (matches.length > 1) throw new CliUsageError(`${id} matches more than one session. Give more of the id.`, 'sessions')
  if (!matches[0]) throw new CliRefusal('SESSION_NOT_RUNNING', `No session ${id} is working on this computer now.`)
  return matches[0]
}

export const runSessions = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'sessions')
  const [action = 'list', id] = operands(run.options, 1, 2, 'sessions')
  const teams = selectTeams(await run.teams(), run.options.team, 'sessions', true)
  if (action === 'list') {
    if (id !== undefined) throw new CliUsageError('sessions list takes no id.', 'sessions')
    const sessions = await sessionsOf(run, teams)
    if (run.options.json) printJson(run.context, sessions.map(asJson))
    else run.context.out(sessions.length ? sessions.map((session) => describeSession(session, heading(session))).join('')
      : 'No agent is working on this computer right now.\n')
    return
  }
  if (action !== 'stop') throw new CliUsageError(`sessions has no "${action}". Use list or stop.`, 'sessions')
  if (id === undefined) throw new CliUsageError('Give the session id: nessie-computer sessions stop <id>.', 'sessions')
  const session = findSession(await sessionsOf(run, teams), id)
  const left = await run.ops(session.team).stopSession(session.sessionId)
  if (run.options.json) printJson(run.context, left.map((rest) => asJson({ ...rest, team: session.team })))
  else run.context.out(`Stopped ${session.agentName ?? 'the agent'}'s work in ${session.team.label}. `
    + 'Nessie is told, and nothing more from that session runs here.\n')
}
