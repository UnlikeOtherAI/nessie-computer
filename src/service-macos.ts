import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  assertExecutorIdentifier, createExecutorServiceEnvironment, executorServiceStateRoot,
  type ExecutorServiceEnvironment,
} from './service-environment.js'
import { macServiceRuntimePaths, verifyMacServiceInstallation } from './service-macos-installation.js'
import { serviceAutoRestartEnabled } from './service-restart.js'

type MacServiceEnvironment = ExecutorServiceEnvironment & { launcher: string; searchPath: string; uid: number }
/** `keepAlive` is the team's restart setting (`service-restart.ts`); absent means on. */
type ServiceOptions = { executorId: string; keepAlive?: boolean; stateDir?: string }

export const createMacServiceEnvironment = (): MacServiceEnvironment => {
  const environment = createExecutorServiceEnvironment()
  const launcher = process.env.NESSIE_EXECUTOR_LAUNCHER ?? ''
  return {
    ...environment, launcher,
    searchPath: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    uid: process.getuid?.() ?? -1,
    verifyPackagedRuntime: () => verifyMacServiceInstallation(launcher, environment.run),
  }
}

const xml = (value: string): string => value.replace(/[<>&"']/g, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[character]!)

/** Finding or removing a launch agent needs no installed runtime, so any install of the command line can. */
type LaunchAgentEnvironment = Pick<MacServiceEnvironment, 'platform' | 'home' | 'uid' | 'run'>

/** One team's launch agent: its launchd label, and where its plist and log live. */
export const macLaunchAgent = (executorId: string, environment: LaunchAgentEnvironment) => {
  if (environment.platform !== 'darwin' || environment.uid < 0) throw new Error('launchd services require macOS.')
  const id = assertExecutorIdentifier(executorId)
  const label = `works.nessie.executor.${id}`
  return {
    domain: `gui/${environment.uid}`, id, label,
    path: join(environment.home, 'Library/LaunchAgents', `${label}.plist`),
    log: join(environment.home, 'Library/Logs/NessieExecutor', `${id}.log`),
  }
}

export const macServicePlan = (options: ServiceOptions, environment: MacServiceEnvironment) => {
  const { domain, id, label, path, log } = macLaunchAgent(options.executorId, environment)
  const runtime = macServiceRuntimePaths(environment.launcher)
  const stateDir = join(executorServiceStateRoot(environment.home), id)
  if (options.stateDir && resolve(options.stateDir) !== stateDir) throw new Error('The service must use this team’s default state directory.')
  const strings = [runtime.node, runtime.bundle, 'serve', '--state-dir', stateDir]
    .map((argument) => `<string>${xml(argument)}</string>`).join('')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><${options.keepAlive === false ? 'false' : 'true'}/>
<key>ThrottleInterval</key><integer>5</integer>
<key>EnvironmentVariables</key><dict>
<key>NESSIE_EXECUTOR_SUPERVISOR</key><string>service</string>
<key>NESSIE_EXECUTOR_PACKAGED_CLI</key><string>1</string>
<key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string>
<key>PATH</key><string>${xml(environment.searchPath)}</string></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`
  return { domain, label, log, path, plist, stateDir }
}

const launchctl = async (environment: Pick<MacServiceEnvironment, 'run'>, args: string[]): Promise<void> => {
  const result = await environment.run('/bin/launchctl', args)
  if (result.code !== 0) throw new Error(`launchctl ${args[0]} failed (${result.code}). Run this in your logged-in macOS account.`)
}

/** Whether the plist is there; one that is not an ordinary file of this account is never touched. */
const checkPlist = async (path: string, uid: number): Promise<boolean> => {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid)) {
    throw new Error('The team\'s launch agent is not an ordinary file of this account, so it was left alone.')
  }
  return entry !== null
}

export const enableMacExecutorService = async (
  options: ServiceOptions,
  environment: MacServiceEnvironment = createMacServiceEnvironment(),
): Promise<void> => {
  const { stateDir } = macServicePlan(options, environment)
  await environment.loadPairedState(stateDir)
  await environment.verifyPackagedRuntime()
  const plan = macServicePlan({ ...options, keepAlive: await serviceAutoRestartEnabled(stateDir) }, environment)
  await checkPlist(plan.path, environment.uid)
  await mkdir(dirname(plan.path), { recursive: true, mode: 0o700 })
  await mkdir(dirname(plan.log), { recursive: true, mode: 0o700 })
  const target = `${plan.domain}/${plan.label}`
  if ((await environment.run('/bin/launchctl', ['print', target])).code === 0) {
    await launchctl(environment, ['bootout', target])
  }
  await writeFile(plan.path, plan.plist, { mode: 0o600 })
  await launchctl(environment, ['enable', target])
  await launchctl(environment, ['bootstrap', plan.domain, plan.path])
  await launchctl(environment, ['print', target])
  environment.write(`Enabled ${plan.label}. It starts when you log in. Logs: ${plan.log}`)
}

/**
 * Stops and removes one team's launch agent, however the command line was
 * installed; true when there was one to remove. Only the agent goes: the team,
 * its access and its pause stay on this computer.
 */
export const disableMacExecutorService = async (
  options: { executorId: string }, environment: LaunchAgentEnvironment = createMacServiceEnvironment(),
): Promise<boolean> => {
  const agent = macLaunchAgent(options.executorId, environment)
  const file = await checkPlist(agent.path, environment.uid)
  const target = `${agent.domain}/${agent.label}`
  const loaded = (await environment.run('/bin/launchctl', ['print', target])).code === 0
  if (loaded) await launchctl(environment, ['bootout', target])
  if (file) {
    await unlink(agent.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
  return file || loaded
}

export const runMacServiceCli = async (args: string[]): Promise<boolean> => {
  if (process.platform !== 'darwin' || !['enable', 'disable', 'status'].includes(args[0] ?? '')) return false
  const environment = createMacServiceEnvironment()
  const id = args[1] && !args[1].startsWith('--') ? assertExecutorIdentifier(args[1]) : undefined
  const option = (flag: string): string | undefined => {
    const position = args.indexOf(flag)
    if (position < 0) return undefined
    const value = args[position + 1]
    if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${flag}.`)
    return value
  }
  if (args[0] === 'status') {
    const root = option('--state-root') ?? executorServiceStateRoot(environment.home)
    const paired = await environment.listStateDirectories(root)
    if (id && !paired.includes(id)) throw new Error('No team with that id is on this computer.')
    if (!paired.length) environment.write('No teams on this computer.')
    for (const executorId of id ? [id] : paired) {
      const label = `works.nessie.executor.${executorId}`
      const status = await environment.run('/bin/launchctl', ['print', `gui/${environment.uid}/${label}`])
      const restart = await serviceAutoRestartEnabled(join(root, executorId)) ? 'on' : 'off'
      environment.write(`team ${executorId}: ${status.code === 0 ? 'loaded' : 'stopped'} autorestart=${restart}`)
    }
  } else {
    if (!id) throw new Error('Choose a team id: nessie-computer teams shows them.')
    if (args[0] === 'enable') await enableMacExecutorService({ executorId: id, stateDir: option('--state-dir') }, environment)
    else {
      await disableMacExecutorService({ executorId: id }, environment)
      environment.write(`Disabled works.nessie.executor.${id}. The team and its access settings stay on this computer.`)
    }
  }
  return true
}
