import { canonicalWords, HELP_ENTRIES } from './cli-help-entries.js'
import { helpText } from './cli-help.js'
import { parseCliOptions, type CliOptions } from './cli-options.js'
import { CliUsageError, EXIT, processContext, reportFailure, type CliContext } from './cli-output.js'
import { teamOps, type TeamOps } from './cli-team-ops.js'
import { runsCliServices, teamRunner, type TeamRunner } from './cli-team-runner.js'
import {
  describeTeams, findLocalTeams, refreshStaleTeamNames, selectTeam, type CliTeam, type LabelledTeam,
} from './cli-teams.js'
import { findServiceTeams } from './cli-teams-service.js'
import type { TeamNamesApi } from './team-names.js'
import { unpairExecutor, type UnpairResult } from './unpair.js'
import { executorSoftwareVersion } from './updates/version.js'
import { windowsServiceRelay, type ServiceCall } from './windows-service-control.js'

/**
 * `nessie-computer`: the commands a person types, built like the window
 * (contract §9). Each command calls the operation the apps' plumbing verb
 * calls; the plumbing verbs themselves stay in `cli.ts`, unchanged.
 */

export type CliRun = {
  context: CliContext
  options: CliOptions
  /** The help entry this command belongs to, e.g. `access programs`. */
  command: string
  /** The teams, as the window's team list shows them. */
  teams: () => Promise<LabelledTeam[]>
  /** The teams and, on Windows, the connections that hold their ChatGPT plans. */
  connections: () => Promise<LabelledTeam[]>
  /** The team `--team` names, or the only one. */
  team: () => Promise<LabelledTeam>
  /** What can be done to a team, wherever it runs. */
  ops: (team: CliTeam) => TeamOps
  /** Who runs this computer's teams (`cli-team-runner.ts`). */
  runner: () => Promise<TeamRunner>
  /** Why the Windows service's teams could not be listed, when they could not. */
  serviceNote: () => Promise<string | undefined>
  service: ServiceCall
  /** Removes a team's connection; `unpairExecutor` outside tests. */
  unpair: (stateDir: string) => Promise<UnpairResult>
}

type Handler = (run: CliRun) => Promise<void>

const USER_COMMANDS = new Set(['help', 'status', 'teams', 'add', 'connect', 'disconnect', 'pause', 'resume',
  'access', 'requests', 'sessions', 'documents', 'ai', 'settings'])

/** A team's state folder on the command line marks a plumbing verb, which the apps call. */
const PLUMBING_OPTIONS = new Set(['--state-dir', '--state-root', '--executor'])

/**
 * Whether `args` is one of these commands rather than a plumbing verb. Names
 * shared with plumbing (`status`, `teams`, `connect`, `pause`, `resume`) are
 * plumbing when they carry a state folder, or — for `status` — an executor id.
 */
export const isUserCommand = (args: readonly string[]): boolean => {
  const [first, second] = args
  if (first === undefined) return true
  if (args.length === 1 && ['--help', '-h', '--version', '-v'].includes(first)) return true
  if (!USER_COMMANDS.has(first)) return false
  if (args.some((argument) => PLUMBING_OPTIONS.has(argument.split('=')[0]!))) return false
  return !(first === 'status' && second !== undefined && !second.startsWith('-'))
}

/** The help entry for a command line: the longest run of its words that has one. */
const commandOf = (words: readonly string[]): string => {
  for (let length = Math.min(words.length, 2); length > 0; length -= 1) {
    const candidate = words.slice(0, length).join(' ')
    if (HELP_ENTRIES.some((entry) => entry.command === candidate)) return candidate
  }
  return words[0] ?? 'help'
}

const handlers = async (command: string): Promise<Handler | undefined> => {
  const group = command.split(' ')[0]
  if (['status', 'teams', 'pause', 'resume'].includes(command)) return (await import('./cli-overview.js')).OVERVIEW[command]
  if (command === 'add' || command === 'disconnect') return (await import('./cli-connect.js')).CONNECTING[command]
  if (command === 'access programs') return (await import('./cli-access-programs.js')).runAccessPrograms
  if (command === 'access local-apps') return (await import('./cli-access-local-apps.js')).runAccessLocalApps
  if (group === 'access') return (await import('./cli-access.js')).ACCESS[command]
  if (command === 'requests') return (await import('./cli-requests.js')).runRequests
  if (command === 'sessions') return (await import('./cli-sessions.js')).runSessions
  if (command === 'documents') return (await import('./cli-documents.js')).runDocuments
  if (command === 'ai plans') return (await import('./cli-ai-plans.js')).runAiPlans
  if (command === 'ai servers') return (await import('./cli-ai-servers.js')).runAiServers
  if (command === 'ai local') return (await import('./cli-ai-local.js')).runAiLocal
  if (command === 'settings') return (await import('./cli-settings.js')).runSettings
  return undefined
}

export type UserCliOptions = {
  context?: CliContext
  /** Where stale team names are read from; Nessie's batched route outside tests (`team-names.ts`). */
  namesApi?: TeamNamesApi
  unpair?: (stateDir: string) => Promise<UnpairResult>
  /** The Windows service's control channel; the installed relay outside tests. */
  service?: ServiceCall
}

/** The run's view of this computer's teams, found once and shared by every step of one command. */
const teamFinder = (context: CliContext, service: ServiceCall, namesApi: TeamNamesApi | undefined) => {
  let runner: Promise<TeamRunner> | undefined
  let found: Promise<{ teams: LabelledTeam[]; note?: string }> | undefined
  const runnerOf = () => { runner ??= teamRunner(context); return runner }
  const find = () => {
    found ??= (async () => {
      const local = await findLocalTeams(context, runsCliServices(await runnerOf()))
      // The labels this account's teams are shown by, asked again once an hour old (`team-label.ts`).
      await refreshStaleTeamNames(local, namesApi, context.now)
      const services = context.platform === 'win32' ? await findServiceTeams(service) : { teams: [] }
      return { teams: await describeTeams([...local, ...services.teams]),
        ...('note' in services && services.note ? { note: services.note } : {}) }
    })()
    return found
  }
  return { runner: runnerOf, find }
}

/** Runs one command line and returns its exit code. */
export const runUserCli = async (args: readonly string[], dependencies: UserCliOptions = {}): Promise<number> => {
  const context = dependencies.context ?? processContext()
  let json = args.includes('--json')
  try {
    if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
      context.out(`nessie-computer ${executorSoftwareVersion()}\n`)
      return EXIT.ok
    }
    const parsed = parseCliOptions(args)
    // `connect` is `add` under its older name: same command, same help, same messages.
    const options = { ...parsed, words: canonicalWords(parsed.words) }
    json = options.json
    if (options.words.length === 0 || options.words[0] === 'help') {
      const asked = options.words.slice(1)
      context.out(`${helpText(asked.length === 0 && options.help && options.words.length ? ['help'] : asked)}\n`)
      return EXIT.ok
    }
    const command = commandOf(options.words)
    if (options.help) {
      context.out(`${helpText(options.words)}\n`)
      return EXIT.ok
    }
    const handler = await handlers(command)
    if (!handler) {
      const group = options.words[0] === 'access' || options.words[0] === 'ai' ? options.words[0] : undefined
      throw new CliUsageError(group
        ? `Say which part: ${HELP_ENTRIES.filter((entry) => entry.command.startsWith(`${group} `))
          .map((entry) => entry.command).join(', ')}.`
        : `nessie-computer has no command "${options.words.join(' ')}".`, group)
    }
    const service = dependencies.service ?? windowsServiceRelay(context.run, context.platform)
    const unpair = dependencies.unpair ?? unpairExecutor
    const finder = teamFinder(context, service, dependencies.namesApi)
    const teams = async () => (await finder.find()).teams.filter((team) => !team.planConnectionOf)
    await handler({
      context, options, command, teams, service, unpair,
      connections: async () => (await finder.find()).teams,
      team: async () => selectTeam(await teams(), options.team, command),
      ops: (team) => teamOps(team, { service, run: context.run, unpair }),
      runner: finder.runner,
      serviceNote: async () => (await finder.find()).note,
    })
    return EXIT.ok
  } catch (error) {
    return reportFailure(context, json, error)
  }
}
