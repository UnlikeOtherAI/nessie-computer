import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { CliRefusal, CliUsageError, listed, type CliContext } from './cli-output.js'
import { readOwnerPause } from './owner-pause.js'
import { pairingCodeStatus, type PairingCodeView } from './pairing-code.js'
import { listProgramRequests } from './program-requests.js'
import { executorServiceStateRoot } from './service-environment.js'
import { loadExecutorState, type ExecutorLocalState } from './state-store.js'

/**
 * The teams connected on this computer, found where the apps and the
 * command line keep them, so the command line controls the same teams the
 * window does (contract §1.7).
 *
 * - Every platform: `~/.local/state/nessie-executor/<id>`, the command line's
 *   own teams (Linux services, macOS launchd agents and Windows teams that run
 *   under this account).
 * - macOS: the menu bar app's teams under Application Support, the same
 *   folders its `ExecutorPaths.discover` reads.
 *
 * A Windows team owned by the background service keeps its state where only
 * the service can write, so it is not one of these.
 */
export type CliTeam = {
  stateDir: string
  state: ExecutorLocalState
  executorId: string
  /** Kept by the command line's own services, which the command line also starts and stops. */
  cliService: boolean
}

export type TeamNames = { teamName: string | null; organizationName: string | null }

export type TeamStatus = 'working' | 'paused' | 'needs_you' | 'not_connected'

export type LabelledTeam = CliTeam & {
  label: string
  names: TeamNames | null
  server: string
  running: boolean
  paused: boolean
  pendingProgramRequests: number
  status: TeamStatus
}

export const STATUS_WORDS: Record<TeamStatus, string> = {
  working: 'Working', paused: 'Paused', needs_you: 'Needs you', not_connected: 'Not connected',
}

export const UNKNOWN_TEAM_NAME = 'Team name not available yet'

const STATE_FILE = 'executor-state.json'
const DIRECTORY_NAME = /^[A-Za-z0-9-]{1,128}$/u

const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Where teams live on this platform: folders that are a team, and folders whose children are. */
export const teamLocations = (platform: NodeJS.Platform, home: string): { teams: string[]; roots: string[] } => {
  const cli = executorServiceStateRoot(home)
  if (platform !== 'darwin') return { teams: [], roots: [cli] }
  const support = join(home, 'Library', 'Application Support')
  return {
    teams: [join(support, 'Nessie Executor', 'executor')],
    roots: [cli, join(support, 'Nessie Executor', 'connections'),
      join(support, 'com.unlikeotherai.nessie.desktop', 'executors'),
      join(support, 'com.unlikeotherai.nessie.executor.menubar', 'executors')],
  }
}

const isPlainDirectory = async (path: string): Promise<boolean> => {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (absent(error)) return null
    throw error
  })
  return Boolean(metadata?.isDirectory() && !metadata.isSymbolicLink())
}

const hasFile = async (directory: string, name: string): Promise<boolean> => (
  lstat(join(directory, name)).then((metadata) => metadata.isFile(), (error: unknown) => {
    if (absent(error)) return false
    throw error
  })
)

const childDirectories = async (root: string): Promise<string[]> => {
  if (!await isPlainDirectory(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && DIRECTORY_NAME.test(entry.name))
    .map((entry) => join(root, entry.name)).sort()
}

/** Every connected team, once each. A folder whose state cannot be read is reported, not skipped silently. */
export const findTeams = async (context: Pick<CliContext, 'platform' | 'home' | 'err'>): Promise<CliTeam[]> => {
  const locations = teamLocations(context.platform, context.home)
  const cliRoot = resolve(executorServiceStateRoot(context.home))
  const candidates = [...locations.teams]
  for (const root of locations.roots) candidates.push(...await childDirectories(root))
  const teams: CliTeam[] = []
  for (const stateDir of candidates) {
    if (!await isPlainDirectory(stateDir) || !await hasFile(stateDir, STATE_FILE)) continue
    const state = await loadExecutorState(stateDir).catch((error: unknown) => {
      context.err(`A team's settings in ${stateDir} could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
      return null
    })
    if (!state || teams.some((team) => team.executorId === state.executorId)) continue
    teams.push({ stateDir, state, executorId: state.executorId,
      cliService: resolve(stateDir) === join(cliRoot, state.executorId) })
  }
  return teams
}

/** Pairings started by `connect` that Nessie has not finished yet. */
export const findPendingConnections = async (home: string): Promise<string[]> => {
  const pending: string[] = []
  for (const directory of await childDirectories(executorServiceStateRoot(home))) {
    if (await hasFile(directory, 'executor-pairing-code.json')) pending.push(directory)
  }
  return pending
}

/**
 * Whether a daemon runs this team now: the lease file names a live process.
 * Read only; the lease itself belongs to the daemon (`process-lease.ts`), which
 * reads `EPERM` the same way, as a process that exists.
 */
export const daemonRunning = async (stateDir: string): Promise<boolean> => {
  const text = await readFile(join(stateDir, 'daemon.pid'), 'utf8').catch(() => '')
  if (!/^[1-9][0-9]{0,9}$/u.test(text.trim())) return false
  try {
    process.kill(Number(text.trim()), 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type NameLookup = (stateDir: string) => Promise<Pick<PairingCodeView, 'teamName' | 'organizationName'>>

const NAME_TIMEOUT_MS = 4_000

/** The team and organisation names, read from Nessie as the apps read them; null when Nessie can't say. */
export const readTeamNames = async (team: CliTeam, lookup: NameLookup = pairingCodeStatus): Promise<TeamNames | null> => {
  let timer: NodeJS.Timeout | undefined
  try {
    const view = await Promise.race([lookup(team.stateDir), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), NAME_TIMEOUT_MS)
      timer.unref()
    })])
    if (!view.teamName && !view.organizationName) return null
    return { teamName: view.teamName ?? null, organizationName: view.organizationName ?? null }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const hostOf = (apiBaseUrl: string): string => {
  try { return new URL(apiBaseUrl).host } catch { return apiBaseUrl }
}

/**
 * `{teamName} · {organizationName}`; two equal labels get ` ({serverHost})`;
 * an unknown name says so (contract §2). Never an id.
 */
export const labelFor = (names: TeamNames | null, server: string, others: readonly (TeamNames | null)[]): string => {
  const own = names ? [names.teamName, names.organizationName].filter(Boolean).join(' · ') : ''
  if (!own) return UNKNOWN_TEAM_NAME
  const same = (other: TeamNames | null) => (other ? [other.teamName, other.organizationName].filter(Boolean).join(' · ') : '') === own
  return others.some(same) ? `${own} (${server})` : own
}

/** One of the contract's status words, decided as the window decides it (`teams.js`). */
export const statusOf = (team: { paused: boolean; pendingProgramRequests: number; running: boolean }): TeamStatus => {
  if (team.paused) return 'paused'
  if (team.pendingProgramRequests > 0) return 'needs_you'
  return team.running ? 'working' : 'not_connected'
}

/** A pause file that cannot be read counts as paused, as it does in the daemon. */
export const teamPaused = async (stateDir: string): Promise<boolean> =>
  (await readOwnerPause(stateDir).catch(() => ({ paused: true }))) !== null

/** Every team with its label and status. */
export const describeTeams = async (teams: readonly CliTeam[], lookup?: NameLookup): Promise<LabelledTeam[]> => {
  const names = await Promise.all(teams.map((team) => readTeamNames(team, lookup)))
  return Promise.all(teams.map(async (team, index) => {
    const server = hostOf(team.state.apiBaseUrl)
    const running = await daemonRunning(team.stateDir)
    const paused = await teamPaused(team.stateDir)
    const pendingProgramRequests = (await listProgramRequests(team.stateDir).catch(() => [])).length
    return {
      ...team, names: names[index]!, server, running, paused, pendingProgramRequests,
      label: labelFor(names[index]!, server, names.filter((_, other) => other !== index)),
      status: statusOf({ paused, pendingProgramRequests, running }),
    }
  }))
}

const choices = (teams: readonly LabelledTeam[]): string => listed(teams.map((team) => (
  team.label === UNKNOWN_TEAM_NAME ? team.executorId : `"${team.label}"`)))

/**
 * The team `--team` names: its id, its label, or a unique part of the label
 * (any case). Without `--team` the only team, when there is just one.
 */
export const selectTeam = (teams: readonly LabelledTeam[], query: string | undefined, command: string): LabelledTeam => {
  if (teams.length === 0) {
    throw new CliRefusal('NO_TEAMS', 'No teams are connected to this computer. Run nessie-computer connect first.')
  }
  if (query === undefined) {
    if (teams.length === 1) return teams[0]!
    throw new CliUsageError(`Choose a team with --team: ${choices(teams)}.`, command)
  }
  const wanted = query.trim().toLowerCase()
  const byId = teams.find((team) => team.executorId.toLowerCase() === wanted)
  if (byId) return byId
  const byLabel = teams.filter((team) => team.label !== UNKNOWN_TEAM_NAME && team.label.toLowerCase() === wanted)
  if (byLabel.length === 1) return byLabel[0]!
  const partial = teams.filter((team) => team.label !== UNKNOWN_TEAM_NAME && team.label.toLowerCase().includes(wanted))
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) throw new CliUsageError(`"${query}" matches more than one team: ${choices(partial)}.`, command)
  throw new CliRefusal('TEAM_NOT_FOUND', `No team matches "${query}". Teams on this computer: ${choices(teams)}.`)
}

/** The teams a command acts on: the one `--team` names, or every team when `all` allows it. */
export const selectTeams = (
  teams: readonly LabelledTeam[], query: string | undefined, command: string, all: boolean,
): LabelledTeam[] => (query === undefined && all ? [...teams] : [selectTeam(teams, query, command)])
