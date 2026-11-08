import { join } from 'node:path'

import { acceptOnly, onOff, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson, type CliContext } from './cli-output.js'
import type { LabelledTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { createExecutorServiceEnvironment } from './service-environment.js'
import { runServiceRestartCli } from './service-restart-cli.js'
import { serviceAutoRestartEnabled } from './service-restart.js'
import { runUpdateCli } from './updates/cli.js'
import { localUpdate } from './updates/native-client.js'

/**
 * The Settings tab's computer-wide settings: restart a team if it stops,
 * software updates (the `updates` verb) and where the logs are.
 */

const APP_RESTART = 'Teams the Nessie Computer app runs follow "Restart a team if it stops" in its Settings.'

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

const restartRows = async (teams: readonly LabelledTeam[]) => Promise.all(teams.filter((team) => team.cliService)
  .map(async (team) => ({ executorId: team.executorId, label: team.label,
    autoRestart: await serviceAutoRestartEnabled(team.stateDir) })))

const autoRestart = async (run: CliRun, choice: string | undefined): Promise<void> => {
  if (run.context.platform === 'win32') {
    throw new CliRefusal('AUTO_RESTART_IN_APP', 'On Windows, change "Restart a team if it stops" in Nessie Computer → Settings.')
  }
  const teams = await run.teams()
  if (choice !== undefined) {
    const value = onOff(choice, 'settings auto-restart') ? 'on' : 'off'
    for (const team of teams.filter((entry) => entry.cliService)) {
      await runServiceRestartCli(['autorestart', team.executorId, value], { ...createExecutorServiceEnvironment(), write: () => undefined })
    }
  }
  const rows = await restartRows(teams)
  if (run.options.json) {
    printJson(run.context, rows)
    return
  }
  const others = teams.some((team) => !team.cliService)
  run.context.out([
    ...(rows.length ? [`Restart a team if it stops:\n${columns(rows.map((row) => [row.label, row.autoRestart ? 'on' : 'off']), '  ')}`]
      : ['No teams here run as command-line services.']),
    ...(others || !rows.length ? [APP_RESTART] : []),
  ].join('\n') + '\n')
}

export const runSettings = async (run: CliRun): Promise<void> => {
  acceptOnly(run.options, 'settings')
  const [section, ...rest] = operands(run.options, 1, 3, 'settings')
  if (section === 'auto-restart') {
    if (rest.length > 1) throw new CliUsageError('Use settings auto-restart on|off.', 'settings')
    await autoRestart(run, rest[0])
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
  if (section !== undefined) throw new CliUsageError(`settings has no "${section}". Use auto-restart, updates or logs.`, 'settings')
  const teams = await run.teams()
  if (run.options.json) {
    printJson(run.context, { autoRestart: run.context.platform === 'win32' ? null : await restartRows(teams),
      updates: await localUpdate({ operation: 'status' }).catch(() => null), logs: logLocations(run.context, teams) })
    return
  }
  if (run.context.platform !== 'win32') await autoRestart(run, undefined)
  await runUpdateCli(['updates']).catch((error: unknown) => {
    run.context.out(`${error instanceof Error ? error.message : String(error)}\n`)
    return true
  })
  run.context.out(`Logs:\n${logLocations(run.context, teams).map((line) => `  ${line}`).join('\n')}\n`)
}
