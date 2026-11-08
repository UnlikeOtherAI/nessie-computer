import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson, type CliContext } from './cli-output.js'
import { selectTeams, type LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { answerProgramRequest } from './program-request-cli.js'
import { listProgramRequests, type ProgramRequest, type ProgramRequestAnswer } from './program-requests.js'
import { loadExecutorState } from './state-store.js'

/**
 * `requests`: the program requests the Overview's "Needs you" list shows,
 * across every team, answered through `answerProgramRequest` — the function
 * `program-request answer` runs for the apps.
 */

type TeamRequest = ProgramRequest & { agentName?: string; team: LabelledTeam }

const ANSWERS: Record<string, ProgramRequestAnswer> = { 'allow-once': 'once', always: 'always', deny: 'deny' }
const WATCH_MS = 1_000
const SHORT_ID = 8

const requestsOf = async (teams: readonly LabelledTeam[]): Promise<TeamRequest[]> => (await Promise.all(
  teams.map(async (team) => (await listProgramRequests(team.stateDir)).map((request) => ({ ...request, team })))))
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
    for (const request of await requestsOf(teams)) {
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
  const all = await run.teams()
  if (action === 'list' || action === 'watch') {
    if (id !== undefined) throw new CliUsageError(`requests ${action} takes no id.`, 'requests')
    const teams = selectTeams(all, run.options.team, 'requests', true)
    if (action === 'watch') await watch(run, teams, run.context)
    const requests = await requestsOf(teams)
    if (run.options.json) printJson(run.context, requests.map(asJson))
    else run.context.out(requests.length ? `${table(requests, run.context.now())}\n` : 'No program requests are waiting.\n')
    return
  }
  const answer = ANSWERS[action]
  if (!answer) throw new CliUsageError(`requests has no "${action}". Use list, allow-once, always, deny or watch.`, 'requests')
  if (id === undefined) throw new CliUsageError(`Give the request id: nessie-computer requests ${action} <id>.`, 'requests')
  const request = findRequest(await requestsOf(selectTeams(all, run.options.team, 'requests', true)), id)
  const state = await loadExecutorState(request.team.stateDir)
  let printed = ''
  await answerProgramRequest(request.team.stateDir, state, { answer, id: request.id, json: false },
    (text) => { printed += text })
  if (run.options.json) printJson(run.context, { ...asJson(request), answer })
  else run.context.out(printed)
}
