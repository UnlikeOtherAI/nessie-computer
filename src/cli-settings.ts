import { join } from 'node:path'

import { appAutoRestartEnabled, loginItemEnabled, setAppAutoRestart, setLoginItem } from './cli-app-settings.js'
import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson, type CliContext } from './cli-output.js'
import type { TeamRunner } from './cli-team-runner.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { createExecutorServiceEnvironment } from './service-environment.js'
import { runServiceRestartCli } from './service-restart-cli.js'
import { serviceAutoRestartEnabled } from './service-restart.js'
import { runUpdateCli } from './updates/cli.js'
import { localUpdate } from './updates/native-client.js'

/**
 * The Settings tab's computer-wide settings: open at login, restart a team if
 * it stops, software updates (the `updates` verb) and where the logs are. The
 * app's two settings are kept where the app keeps them (`cli-app-settings.ts`),
 * so a change here shows in the window and the other way round.
 */

const SERVICE_RESTARTS = 'The Nessie Computer service always starts its own teams again.'

/** Where each kind of team writes its logs on this platform. */
export const logLocations = (context: Pick<CliContext, 'platform' | 'home'>, teams: readonly LabelledTeam[]): string[] => {
  if (context.platform === 'darwin') {
    return [join(context.home, 'Library', 'Logs', 'Nessie Computer'), join(context.home, 'Library', 'Logs', 'NessieExecutor')]
  }
  if (context.platform === 'win32') {
    return [join(process.env.ProgramData ?? 'C:\\ProgramData', 'Nessie Executor', 'logs')]
  }
  return teams.length ? teams.map((team) => `journalctl --user -u nessie-executor@${team.executorId}`)
    : ['journalctl --user -u "nessie-executor@*"']
}

const appRuns = (runner: TeamRunner): boolean => runner === 'mac-app' || runner === 'windows-app'

type RestartReading = { autoRestart: boolean | null; teams: Array<{ executorId: string; label: string; autoRestart: boolean }> }

/**
 * The app's one computer-wide switch where the app runs the teams; otherwise
 * each command-line service's own setting, listed per team.
 */
const readRestart = async (run: CliRun, teams: readonly LabelledTeam[]): Promise<RestartReading> => {
  if (appRuns(await run.runner())) return { autoRestart: await appAutoRestartEnabled(run.context), teams: [] }
  return { autoRestart: null, teams: await Promise.all(teams.flatMap((team) => (team.route === 'local' && team.cliService
    ? [serviceAutoRestartEnabled(team.stateDir).then((autoRestart) => ({ executorId: team.executorId, label: team.label, autoRestart }))]
    : []))) }
}

const restartText = (reading: RestartReading, teams: readonly LabelledTeam[]): string => {
  const serviceTeams = teams.some((team) => team.route === 'service')
  if (reading.autoRestart !== null) {
    return [`Restart a team if it stops: ${reading.autoRestart ? 'on' : 'off'}`, ...(serviceTeams ? [SERVICE_RESTARTS] : [])].join('\n')
  }
  return reading.teams.length
    ? `Restart a team if it stops:\n${columns(reading.teams.map((row) => [row.label, row.autoRestart ? 'on' : 'off']), '  ')}`
    : 'Restart a team if it stops: no teams yet.'
}

const autoRestart = async (run: CliRun, choice: string | undefined): Promise<void> => {
  const teams = await run.teams()
  if (choice !== undefined) {
    const enabled = onOff(choice, 'settings auto-restart')
    if (appRuns(await run.runner())) await setAppAutoRestart(run.context, enabled)
    for (const team of teams) {
      if (team.route !== 'local' || !team.cliService) continue
      await runServiceRestartCli(['autorestart', team.executorId, enabled ? 'on' : 'off'],
        { ...createExecutorServiceEnvironment(), write: () => undefined })
    }
  }
  const reading = await readRestart(run, teams)
  if (run.options.json) printJson(run.context, reading)
  else run.context.out(`${restartText(reading, teams)}\n`)
}

const login = async (run: CliRun, choice: string | undefined): Promise<void> => {
  const enabled = choice === undefined ? await loginItemEnabled(run.context)
    : await setLoginItem(run.context, onOff(choice, 'settings login'))
  if (run.options.json) printJson(run.context, { openAtLogin: enabled })
  else run.context.out(`Open Nessie Computer when I log in: ${enabled ? 'on' : 'off'}\n`)
}

export const runSettings = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'settings')
  const [section, ...rest] = operands(run.options, 1, 3, 'settings')
  if (section === 'login' || section === 'auto-restart') {
    if (rest.length > 1) throw new CliUsageError(`Use settings ${section} on|off.`, 'settings')
    await (section === 'login' ? login : autoRestart)(run, rest[0])
    return
  }
  if (section === 'updates') {
    const valid = rest.length === 0 || (rest.length === 1 && ['check', 'install'].includes(rest[0]!))
      || (rest.length === 2 && rest[0] === 'automatic' && ['on', 'off'].includes(rest[1]!))
    if (!valid) throw new CliUsageError('Use settings updates, updates check, updates install or updates automatic on|off.', 'settings')
    await runUpdateCli(['updates', ...rest, ...(run.options.json ? ['--json'] : [])])
    return
  }
  if (section === 'logs') {
    if (rest.length) throw new CliUsageError('settings logs takes nothing after it.', 'settings')
    const logs = logLocations(run.context, await run.teams())
    if (run.options.json) printJson(run.context, logs)
    else run.context.out(`${logs.join('\n')}\n`)
    return
  }
  if (section !== undefined) {
    throw new CliUsageError(`settings has no "${section}". Use login, auto-restart, updates or logs.`, 'settings')
  }
  const teams = await run.teams()
  const openAtLogin = await loginItemEnabled(run.context).catch((error: unknown) => (
    error instanceof CliRefusal && error.code === 'LOGIN_ITEM_UNAVAILABLE' ? null : Promise.reject(error)))
  if (run.options.json) {
    printJson(run.context, { openAtLogin, restart: await readRestart(run, teams),
      updates: await localUpdate({ operation: 'status' }).catch(() => null), logs: logLocations(run.context, teams) })
    return
  }
  if (openAtLogin !== null) run.context.out(`Open Nessie Computer when I log in: ${openAtLogin ? 'on' : 'off'}\n`)
  run.context.out(`${restartText(await readRestart(run, teams), teams)}\n`)
  await runUpdateCli(['updates']).catch((error: unknown) => {
    run.context.out(`${error instanceof Error ? error.message : String(error)}\n`)
    return true
  })
  run.context.out(`Logs:\n${logLocations(run.context, teams).map((line) => `  ${line}`).join('\n')}\n`)
}
