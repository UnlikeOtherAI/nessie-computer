import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { CliContext } from './cli-output.js'
import { createExecutorServiceEnvironment, executorServiceStateRoot } from './service-environment.js'
import { enableExecutorService } from './service-linux.js'
import { createMacServiceEnvironment, disableMacExecutorService, enableMacExecutorService } from './service-macos.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'

/**
 * Who runs the teams on this computer — one owner per team, never two:
 *
 * - **A Mac with the Nessie Computer app installed:** the app. It runs every
 *   team it finds, including the ones the command line connects, so the
 *   command line hands a new team to the app and sets up no launch agent.
 * - **A Mac without the app:** the command line's own launch agent per team.
 * - **Linux:** the command line's systemd service per team.
 * - **Windows:** the Nessie Computer app runs the teams connected under this
 *   Windows account; the background service runs its own.
 */
export type TeamRunner = 'mac-app' | 'mac-launch-agent' | 'linux-service' | 'windows-app'

export const MAC_APP_BUNDLE_ID = 'com.unlikeotherai.nessie.executor.menubar'
/** The bundle keeps its original file name; Finder shows it as Nessie Computer. */
const MAC_APP_BUNDLE = 'Nessie Executor.app'
const WINDOWS_APP = 'nessie-executor-tray.exe'

export type MacApp = { path: string; executable: string }

const plistValue = async (context: Pick<CliContext, 'run'>, plist: string, key: string): Promise<string | null> => {
  const result = await context.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])
  return result.code === 0 ? result.stdout.trim() : null
}

/** The installed menu bar app, where the disk image puts it: `/Applications` or `~/Applications`. */
export const installedMacApp = async (context: Pick<CliContext, 'run' | 'home'>): Promise<MacApp | null> => {
  for (const folder of ['/Applications', join(context.home, 'Applications')]) {
    const path = join(folder, MAC_APP_BUNDLE)
    const plist = join(path, 'Contents', 'Info.plist')
    if (!await lstat(plist).then((entry) => entry.isFile(), () => false)) continue
    if (await plistValue(context, plist, 'CFBundleIdentifier') !== MAC_APP_BUNDLE_ID) continue
    const executable = await plistValue(context, plist, 'CFBundleExecutable')
    if (executable && !executable.includes('/')) return { path, executable: join(path, 'Contents', 'MacOS', executable) }
  }
  return null
}

export const teamRunner = async (context: Pick<CliContext, 'platform' | 'run' | 'home'>): Promise<TeamRunner> => {
  if (context.platform === 'win32') return 'windows-app'
  if (context.platform === 'darwin') return await installedMacApp(context) ? 'mac-app' : 'mac-launch-agent'
  return 'linux-service'
}

/** Whether the command line's own background service runs the teams in its folder. */
export const runsCliServices = (runner: TeamRunner): boolean => runner === 'mac-launch-agent' || runner === 'linux-service'

/** This account's launch agents, through the context's own `run`. */
const launchAgents = (context: Pick<CliContext, 'home' | 'run'>) => ({
  platform: 'darwin' as const, home: context.home, uid: process.getuid?.() ?? -1,
  run: async (file: string, args: string[]) => {
    const result = await context.run(file, args)
    return { code: result.code ?? -1, stdout: result.stdout }
  },
})

/**
 * Stops and removes one team's launch agent, when the command line set one
 * up; true when it did. Only the agent goes: pairing, access and pause stay.
 */
export const retireMacLaunchAgent = (context: Pick<CliContext, 'home' | 'run'>, executorId: string): Promise<boolean> => (
  disableMacExecutorService({ executorId }, launchAgents(context)))

/**
 * Hands the command line's earlier launch agents to the app: each one is
 * stopped and removed, so the app is the only thing that runs those teams.
 * Pairing, access and pause stay as they are.
 */
export const retireMacLaunchAgents = async (context: Pick<CliContext, 'home' | 'run'>): Promise<number> => {
  const names = await readdir(executorServiceStateRoot(context.home)).catch(() => [] as string[])
  let retired = 0
  for (const executorId of names.filter((name) => /^[A-Za-z0-9-]{1,128}$/u.test(name))) {
    if (await retireMacLaunchAgent(context, executorId)) retired += 1
  }
  return retired
}

/**
 * Starts a newly connected team with whoever runs this computer's teams, and
 * says so in one sentence. On a Mac with the app, teams the command line ran
 * itself before move to the app along with it.
 */
export const startNewTeam = async (context: Pick<CliContext, 'platform' | 'run' | 'home'>, executorId: string): Promise<string> => {
  const runner = await teamRunner(context)
  if (runner === 'linux-service') {
    await enableExecutorService({ executorId, assumeYes: true },
      { ...createExecutorServiceEnvironment(), write: () => undefined })
    return 'It starts at boot and keeps running after you log out.'
  }
  if (runner === 'mac-launch-agent') {
    await enableMacExecutorService({ executorId }, { ...createMacServiceEnvironment(), write: () => undefined })
    return 'It runs in the background and starts when you log in.'
  }
  if (runner === 'mac-app') {
    const moved = await retireMacLaunchAgents(context)
    const opened = await context.run('/usr/bin/open', ['-g', '-b', MAC_APP_BUNDLE_ID])
    return [opened.code === 0 ? 'Nessie Computer runs it.' : 'Nessie Computer runs it when you next open the app.',
      moved ? `Teams you connected here earlier now run in Nessie Computer too (${moved}).` : ''].filter(Boolean).join(' ')
  }
  const opened = await context.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:NESSIE_COMPUTER_APP'], { env: { NESSIE_COMPUTER_APP: join(packagedRuntimeDirectory(), WINDOWS_APP) } })
  return opened.code === 0 ? 'Nessie Computer runs it.' : 'Nessie Computer runs it when you next open the app.'
}
