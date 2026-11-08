import { describeFolderSync } from './folder-sync/console-state.js'
import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, columns, counted, listed, printJson } from './cli-output.js'
import { advancePendingConnections, type PendingConnection } from './cli-connect.js'
import { STATUS_WORDS, selectTeams, type LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { executorSoftwareVersion } from './updates/version.js'

/** The Overview tab: `status`, `teams`, `who`, and the computer-wide `pause` and `resume`. */

const REASON_NOT_RUNNING = 'Nessie Computer isn\'t running this team'

/** Folder sync states that need the owner, with what to do (the Documents tab's words). */
const DOCUMENT_ATTENTION: Record<string, string> = {
  waiting_for_confirmation: 'Documents are waiting for you to allow them in Nessie',
  needs_reauthorization: 'Documents are waiting for you to allow them again in Nessie',
  needs_attention: 'Documents need your attention',
  root_missing: 'The documents folder is missing',
  disk_full: 'The disk is full, so documents stopped syncing',
}

type NeedsYou = { executorId: string; label: string; kind: 'program_request' | 'documents'; text: string; next: string }

const needsYou = (run: CliRun) => async (team: LabelledTeam): Promise<NeedsYou[]> => {
  const found: NeedsYou[] = []
  const requests = team.pendingProgramRequests ? await run.ops(team).programRequests().catch(() => []) : []
  for (const request of requests) {
    found.push({ executorId: team.executorId, label: team.label, kind: 'program_request',
      text: `${request.agentName ?? 'An agent'} wants to run \`${[request.program, ...request.args].join(' ')}\``,
      next: 'nessie-computer requests list' })
  }
  if (team.route !== 'local') return found
  const sync = await describeFolderSync(team.stateDir, team.executorId).catch(() => null)
  const attention = sync?.enabled ? DOCUMENT_ATTENTION[sync.state] : undefined
  if (attention) {
    found.push({ executorId: team.executorId, label: team.label, kind: 'documents', text: attention,
      next: `nessie-computer documents --team ${team.executorId}` })
  }
  return found
}

const sentence = (teams: readonly LabelledTeam[]): string => {
  if (teams.length === 0) return 'no teams connected'
  const working = teams.filter((team) => team.running && !team.paused).length
  const paused = teams.filter((team) => team.paused).length
  if (paused === teams.length) return 'paused'
  if (working === 0 && paused === 0) return `not connected — ${REASON_NOT_RUNNING.replace('this team', 'any team')}`
  return [working ? `working for ${counted(working, 'team', 'teams')}` : '', paused ? `${paused} paused` : '']
    .filter(Boolean).join(', ')
}

const teamJson = (team: LabelledTeam) => ({
  executorId: team.executorId, label: team.label, teamName: team.names?.teamName ?? null,
  organizationName: team.names?.organizationName ?? null, apiBaseUrl: team.apiBaseUrl, server: team.server,
  status: team.status, running: team.running, paused: team.paused, pendingProgramRequests: team.pendingProgramRequests,
  runBy: team.route === 'service' ? 'service' : 'account',
  ...(team.failure ? { failure: team.failure } : {}),
  ...(team.planConnectionId ? { planConnectionId: team.planConnectionId } : {}),
})

/** A team's status, with the reason when it isn't connected. */
const statusLine = (team: LabelledTeam): string => STATUS_WORDS[team.status]
  + (team.status === 'not_connected' ? ` — ${team.failure ?? REASON_NOT_RUNNING}` : '')

/** The line under a team whose ChatGPT plans live on the Windows service's connection. */
const planLines = (team: LabelledTeam, all: readonly LabelledTeam[]): string[] => {
  const plan = team.planConnectionId ? all.find((entry) => entry.executorId === team.planConnectionId) : undefined
  return plan ? [`    ChatGPT plan connection: ${STATUS_WORDS[plan.status]}`] : []
}

const connectingLines = (pending: readonly PendingConnection[]): string[] => pending.map((entry) => (
  `Connecting a team: pairing code ${entry.code ?? 'not ready yet'} — enter it in Nessie under Computers → Add a computer.`))

const status = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'status')
  operands(run.options, 1, 0, 'status')
  const pending = await advancePendingConnections(run.context)
  const all = await run.teams()
  const connections = await run.connections()
  const note = await run.serviceNote()
  const teams = run.options.team === undefined ? all : selectTeams(all, run.options.team, 'status', false)
  const attention = (await Promise.all(teams.map(needsYou(run)))).flat()
  if (run.options.json) {
    printJson(run.context, { version: executorSoftwareVersion(), teams: teams.map(teamJson),
      needsYou: attention.map(({ executorId, kind, text }) => ({ executorId, kind, text })),
      connecting: pending.map(({ code, expiresAt }) => ({ code, expiresAt })), ...(note ? { service: note } : {}) })
    return
  }
  const lines = [`Nessie Computer ${executorSoftwareVersion()} — ${sentence(teams)}`]
  if (teams.length) {
    lines.push('', ...columns(teams.map((team) => [team.label, statusLine(team)]), '  ').split('\n')
      .flatMap((line, index) => [line, ...planLines(teams[index]!, connections)]))
  } else if (!pending.length) lines.push('', 'Run nessie-computer connect to connect a team.')
  if (note) lines.push('', note)
  if (pending.length) lines.push('', ...connectingLines(pending))
  for (const item of attention) lines.push('', `Needs you: ${item.text} (${item.label})`, `  ${item.next}`)
  run.context.out(`${lines.join('\n')}\n`)
}

const teams = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'teams')
  operands(run.options, 1, 0, 'teams')
  const pending = await advancePendingConnections(run.context)
  const all = await run.teams()
  const note = await run.serviceNote()
  const listedTeams = run.options.team === undefined ? all : selectTeams(all, run.options.team, 'teams', false)
  if (run.options.json) {
    printJson(run.context, listedTeams.map(teamJson))
    return
  }
  if (note) run.context.err(`${note}\n`)
  if (!listedTeams.length) {
    run.context.out(`${[...connectingLines(pending), 'No teams are connected. Run nessie-computer connect to connect one.']
      .join('\n')}\n`)
    return
  }
  run.context.out(`${columns([['TEAM', 'STATUS', 'SERVER', 'ID'], ...listedTeams.map((team) => [
    team.label, STATUS_WORDS[team.status], team.server, team.executorId])])}\n`)
  if (pending.length) run.context.out(`\n${connectingLines(pending).join('\n')}\n`)
}

const who = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'who')
  operands(run.options, 1, 0, 'who')
  const team = await run.team()
  if (team.route === 'local' && !team.state.connectionEpoch) {
    throw new CliRefusal('EXECUTOR_NOT_CONNECTED', `${team.label} hasn't connected to Nessie yet. Start it, then try again.`)
  }
  const audience = await run.ops(team).audience()
  if (run.options.json) {
    printJson(run.context, audience)
    return
  }
  const names = (entries: Array<{ name: string }>) => listed(entries.map((entry) => entry.name))
  const more = audience.peopleCount - audience.people.length
  run.context.out(`Who can send work here for ${team.label}:\n${columns([
    ['Agents', names(audience.agents)],
    ['People', audience.everyoneInTeam ? 'everyone in the team' : `${names(audience.people)}${more > 0 ? ` and ${more} more` : ''}`],
    ['Projects', names(audience.projects)],
  ], '  ')}\n`)
}

const pauseOrResume = (paused: boolean) => async (run: CliRun): Promise<void> => {
  const command = paused ? 'pause' : 'resume'
  acceptOnly(run.options, command)
  operands(run.options, 1, 0, command)
  const chosen = selectTeams(await run.teams(), run.options.team, command, true)
  if (!chosen.length) throw new CliRefusal('NO_TEAMS', 'No teams are connected to this computer.')
  const results = []
  for (const team of chosen) {
    results.push({ executorId: team.executorId, label: team.label, ...await run.ops(team).setPaused(paused) })
  }
  if (run.options.json) {
    printJson(run.context, results)
    return
  }
  const who = chosen.length === 1 && run.options.team !== undefined ? chosen[0]!.label
    : `every team (${listed(chosen.map((team) => team.label))})`
  run.context.out(paused
    ? `Paused ${who}. Agents start nothing new on this computer until you resume. Work already running finishes.\n`
    : `Resumed ${who}. Agents can use this computer again.\n`)
}

export const OVERVIEW: Record<string, (run: CliRun) => Promise<void>> = {
  status, teams, who, pause: pauseOrResume(true), resume: pauseOrResume(false),
}
