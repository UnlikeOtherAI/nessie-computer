import { HELP_ENTRIES } from './cli-help-entries.js'
import { helpText } from './cli-help.js'
import { parseCliOptions, type CliOptions } from './cli-options.js'
import { CliUsageError, EXIT, processContext, reportFailure, type CliContext } from './cli-output.js'
import { describeTeams, findTeams, selectTeam, type LabelledTeam, type NameLookup } from './cli-teams.js'
import { executorSoftwareVersion } from './updates/version.js'

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
  teams: () => Promise<LabelledTeam[]>
  /** The team `--team` names, or the only one. */
  team: () => Promise<LabelledTeam>
}

type Handler = (run: CliRun) => Promise<void>

const USER_COMMANDS = new Set(['help', 'status', 'teams', 'who', 'connect', 'disconnect', 'pause', 'resume',
  'access', 'requests', 'documents', 'ai', 'settings'])

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
  if (['status', 'teams', 'who', 'pause', 'resume'].includes(command)) return (await import('./cli-overview.js')).OVERVIEW[command]
  if (command === 'connect' || command === 'disconnect') return (await import('./cli-connect.js')).CONNECTING[command]
  if (command === 'access programs') return (await import('./cli-access-programs.js')).runAccessPrograms
  if (command === 'access local-apps') return (await import('./cli-access-local-apps.js')).runAccessLocalApps
  if (group === 'access') return (await import('./cli-access.js')).ACCESS[command]
  if (command === 'requests') return (await import('./cli-requests.js')).runRequests
  if (command === 'documents') return (await import('./cli-documents.js')).runDocuments
  if (command === 'ai plans') return (await import('./cli-ai-plans.js')).runAiPlans
  if (command === 'ai servers') return (await import('./cli-ai-servers.js')).runAiServers
  if (command === 'settings') return (await import('./cli-settings.js')).runSettings
  return undefined
}

export type UserCliOptions = { context?: CliContext; nameLookup?: NameLookup }

/** Runs one command line and returns its exit code. */
export const runUserCli = async (args: readonly string[], dependencies: UserCliOptions = {}): Promise<number> => {
  const context = dependencies.context ?? processContext()
  let json = args.includes('--json')
  try {
    if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
      context.out(`nessie-computer ${executorSoftwareVersion()}\n`)
      return EXIT.ok
    }
    const options = parseCliOptions(args)
    json = options.json
    if (options.words.length === 0 || options.words[0] === 'help') {
      context.out(`${helpText(options.words.slice(1))}\n`)
      return EXIT.ok
    }
    const command = commandOf(options.words)
    if (options.help) {
      context.out(`${helpText(options.words)}\n`)
      return EXIT.ok
    }
    const handler = await handlers(command)
    if (!handler) {
      throw new CliUsageError(options.words[0] === 'access' || options.words[0] === 'ai'
        ? `Say which part: ${HELP_ENTRIES.filter((entry) => entry.command.startsWith(`${options.words[0]} `))
          .map((entry) => entry.command).join(', ')}.`
        : `nessie-computer has no command "${options.words.join(' ')}".`, options.words[0])
    }
    let found: Promise<LabelledTeam[]> | undefined
    const teams = () => {
      found ??= findTeams(context).then((list) => describeTeams(list, dependencies.nameLookup))
      return found
    }
    await handler({ context, options, command, teams, team: async () => selectTeam(await teams(), options.team, command) })
    return EXIT.ok
  } catch (error) {
    return reportFailure(context, json, error)
  }
}
