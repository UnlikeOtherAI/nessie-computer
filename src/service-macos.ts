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

export const macServicePlan = (options: ServiceOptions, environment: MacServiceEnvironment) => {
  if (environment.platform !== 'darwin' || environment.uid < 0) throw new Error('launchd services require macOS.')
  const id = assertExecutorIdentifier(options.executorId)
  const runtime = macServiceRuntimePaths(environment.launcher)
  const stateDir = join(executorServiceStateRoot(environment.home), id)
  if (options.stateDir && resolve(options.stateDir) !== stateDir) throw new Error('The service must use this team’s default state directory.')
  const label = `works.nessie.executor.${id}`
  const path = join(environment.home, 'Library/LaunchAgents', `${label}.plist`)
  const log = join(environment.home, 'Library/Logs/NessieExecutor', `${id}.log`)
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
  return { domain: `gui/${environment.uid}`, label, log, path, plist, stateDir }
}

const launchctl = async (environment: MacServiceEnvironment, args: string[]): Promise<void> => {
  const result = await environment.run('/bin/launchctl', args)
  if (result.code !== 0) throw new Error(`launchctl ${args[0]} failed (${result.code}). Run this in your logged-in macOS account.`)
}

const checkPlist = async (path: string, uid: number): Promise<void> => {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== uid)) {
    throw new Error('The existing launch agent is not an ordinary file owned by this account.')
  }
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

/** Stops and removes one executor's login agent; nothing to do when it was never enabled. */
export const disableMacExecutorService = async (
  options: { executorId: string }, environment: MacServiceEnvironment,
): Promise<void> => {
  const plan = macServicePlan(options, environment)
  await checkPlist(plan.path, environment.uid)
  const target = `${plan.domain}/${plan.label}`
  if ((await environment.run('/bin/launchctl', ['print', target])).code === 0) {
    await launchctl(environment, ['bootout', target])
  }
  await unlink(plan.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
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
    if (id && !paired.includes(id)) throw new Error('That executor has no paired state.')
    if (!paired.length) environment.write('no paired executors')
    for (const executorId of id ? [id] : paired) {
      const label = `works.nessie.executor.${executorId}`
      const status = await environment.run('/bin/launchctl', ['print', `gui/${environment.uid}/${label}`])
      const restart = await serviceAutoRestartEnabled(join(root, executorId)) ? 'on' : 'off'
      environment.write(`executor ${executorId}: ${status.code === 0 ? 'loaded' : 'stopped'} autorestart=${restart}`)
    }
  } else {
    if (!id) throw new Error('Choose an executor id from nessie-executor teams.')
    if (args[0] === 'enable') await enableMacExecutorService({ executorId: id, stateDir: option('--state-dir') }, environment)
    else {
      await disableMacExecutorService({ executorId: id }, environment)
      environment.write(`Disabled works.nessie.executor.${id}. Pairing and local permissions remain on this computer.`)
    }
  }
  return true
}
