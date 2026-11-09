import { loadExecutorState } from './state-store.js'
import { readTeamLabel } from './team-label.js'
import { refreshTeamNames, type TeamNameSource, type TeamNamesApi } from './team-names.js'

/**
 * `team-names --state-dir <dir> [--state-dir <dir> …] [--json]`: the apps'
 * verb for naming their teams. It asks Nessie once per server for every team
 * listed (`team-names.ts`), saves each answer as that team's label, and prints
 * every team's label as it now stands. The macOS app and the Windows tray run
 * it when they start and every hour; the Windows service runs it for the teams
 * it holds. A folder without a connected team is skipped.
 *
 * Output (`--json`): `{ "teams": [{ executorId, organizationName, teamName,
 * apiBaseUrl }] }`, with null names for a team that has never had any.
 */

export type TeamNamesCliDependencies = { api?: TeamNamesApi; now?: () => Date; write?: (text: string) => void }

const stateDirectories = (args: readonly string[]): string[] => {
  const directories: string[] = []
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--json') continue
    const directory = args[index + 1]
    if (argument !== '--state-dir' || !directory || directory.startsWith('--')) {
      throw new Error('Name each team with --state-dir <folder>.')
    }
    directories.push(directory)
    index += 1
  }
  if (!directories.length) throw new Error('Name each team with --state-dir <folder>.')
  return directories
}

export const runTeamNamesCli = async (
  args: readonly string[], dependencies: TeamNamesCliDependencies = {},
): Promise<boolean> => {
  if (args[0] !== 'team-names') return false
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text) })
  const sources: TeamNameSource[] = []
  for (const stateDir of stateDirectories(args)) {
    const state = await loadExecutorState(stateDir).catch(() => null)
    if (state) sources.push({ stateDir, state })
  }
  await refreshTeamNames(sources, { api: dependencies.api, now: dependencies.now })
  const teams = await Promise.all(sources.map(async ({ stateDir, state }) => {
    const label = await readTeamLabel(stateDir)
    return { executorId: state.executorId, organizationName: label?.organizationName ?? null,
      teamName: label?.teamName ?? null, apiBaseUrl: state.apiBaseUrl }
  }))
  if (args.includes('--json')) write(`${JSON.stringify({ teams })}\n`)
  else {
    for (const team of teams) {
      write(`${[team.teamName, team.organizationName].filter(Boolean).join(' · ') || 'Team name not available yet'}`
        + `  ${team.executorId}\n`)
    }
  }
  return true
}
