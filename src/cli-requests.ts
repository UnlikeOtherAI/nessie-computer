import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson, type CliContext } from './cli-output.js'
import { selectTeams, type LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import type { ProgramRequest, ProgramRequestAnswer } from './program-requests.js'

/**
 * `requests`: the program requests the Overview's "Needs you" list shows,
 * across every team, answered as the apps answer them — `program-request
 * answer` for a team in a state folder, the service's own answer for a team
 * the Windows service runs (only the account that connected it may answer).
 */

type TeamRequest = ProgramRequest & { agentName?: string; team: LabelledTeam }

const ANSWERS: Record<string, ProgramRequestAnswer> = { 'allow-once': 'once', always: 'always', deny: 'deny' }
const WATCH_MS = 1_000
const SHORT_ID = 8

const requestsOf = async (run: CliRun, teams: readonly LabelledTeam[]): Promise<TeamRequest[]> => (await Promise.all(
  teams.map(async (team) => (await run.ops(team).programRequests()).map((request) => ({ ...request, team })))))
  .flat().sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))

const waits = (request: ProgramRequest, now: Date): string => {
  const seconds = Math.max(0, Math.round((Date.parse(request.expiresAt) - now.getTime()) / 1_000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`
}

const asJson = (request: TeamRequest) => ({
  executorId: request.team.executorId, team: request.team.label, id: request.id, program: request.program,
  args: request.args, ...(request.agentName ? { agentName: request.agentName } : {}),
  requestedAt: request.requestedAt, expiresAt: request.expiresAt,
})

const table = (requests: readonly TeamRequest[], now: Date): string => columns([['ID', 'TEAM', 'AGENT', 'PROGRAM', 'WAITS'],
  ...requests.map((request) => [request.id.slice(0, SHORT_ID), request.team.label, request.agentName ?? 'An agent',
    [request.program, ...request.args].join(' '), waits(request, now)])])

/** The one waiting request an id names: the whole id, or a unique beginning of at least four characters. */
const findRequest = (requests: readonly TeamRequest[], id: string): TeamRequest => {
  const wanted = id.trim().toLowerCase()
  if (wanted.length < 4) throw new CliUsageError('Give at least the first four characters of the request id.', 'requests')
  const matches = requests.filter((request) => request.id === wanted || request.id.startsWith(wanted))
  if (matches.length > 1) throw new CliUsageError(`${id} matches more than one request. Give more of the id.`, 'requests')
  if (!matches[0]) {
    throw new CliRefusal('PROGRAM_REQUEST_NOT_WAITING', `No request ${id} is waiting. It may have been answered or have run out of time.`)
  }
  return matches[0]
}

const watch = async (run: CliRun, teams: readonly LabelledTeam[], context: CliContext): Promise<never> => {
  const seen = new Set<string>()
  if (!run.options.json) context.out('Watching for program requests. Press Ctrl+C to stop.\n')
  for (;;) {
    for (const request of await requestsOf(run, teams)) {
      if (seen.has(request.id)) continue
      seen.add(request.id)
      if (run.options.json) context.out(`${JSON.stringify(asJson(request))}\n`)
      else context.out(`${request.agentName ?? 'An agent'} in ${request.team.label} wants to run \``
        + `${[request.program, ...request.args].join(' ')}\` (request ${request.id.slice(0, SHORT_ID)}, waits ${waits(request, context.now())})\n`)
    }
    await context.sleep(WATCH_MS)
  }
}

export const runRequests = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'requests')
  const [action = 'list', id] = operands(run.options, 1, 2, 'requests')
  // Every connection without --team, so a request on a team's ChatGPT plan connection is listed too.
  const chosen = async () => (run.options.team === undefined ? run.connections()
    : selectTeams(await run.teams(), run.options.team, 'requests', false))
  if (action === 'list' || action === 'watch') {
    if (id !== undefined) throw new CliUsageError(`requests ${action} takes no id.`, 'requests')
    const teams = await chosen()
    if (action === 'watch') await watch(run, teams, run.context)
    const requests = await requestsOf(run, teams)
    if (run.options.json) printJson(run.context, requests.map(asJson))
    else run.context.out(requests.length ? `${table(requests, run.context.now())}\n` : 'No program requests are waiting.\n')
    return
  }
  const answer = ANSWERS[action]
  if (!answer) throw new CliUsageError(`requests has no "${action}". Use list, allow-once, always, deny or watch.`, 'requests')
  if (id === undefined) throw new CliUsageError(`Give the request id: nessie-computer requests ${action} <id>.`, 'requests')
  const request = findRequest(await requestsOf(run, await chosen()), id)
  await run.ops(request.team).answer(request, answer)
  if (run.options.json) printJson(run.context, { ...asJson(request), answer })
  else run.context.out(answer === 'once' ? `Allowed ${request.program} this once.\n`
    : answer === 'always' ? `${request.program} is now always allowed for ${request.team.label}.\n`
      : `${request.program} was not allowed.\n`)
}
