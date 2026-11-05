import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  collectExecutorRuntimeFacts, type ExecutorNodeExecutableName, verifyExecutorRuntime,
} from './runtime-integrity.js'
import { type ExecutorServiceEnvironment } from './service-environment.js'

declare const __NESSIE_EXECUTOR_APPLE_TEAM_ID__: string

const RELEASE_TEAM = typeof __NESSIE_EXECUTOR_APPLE_TEAM_ID__ === 'string' ? __NESSIE_EXECUTOR_APPLE_TEAM_ID__ : ''
const INSTALL_MESSAGE = 'Install the signed Homebrew CLI before enabling its service.'
const RUNTIME_NODE: ExecutorNodeExecutableName = 'nessie-executor-runtime'

/** Stable opt paths survive Homebrew upgrades; launchd executes Node directly. */
export const macServiceRuntimePaths = (launcher: string) => {
  if (!isAbsolute(launcher) || !launcher.endsWith('/bin/nessie-executor')) throw new Error(INSTALL_MESSAGE)
  const runtime = join(dirname(dirname(launcher)), 'libexec/runtime')
  return { node: join(runtime, RUNTIME_NODE), bundle: join(runtime, 'nessie-executor.cjs') }
}

export const verifyMacServiceInstallation = async (
  launcher: string,
  run: ExecutorServiceEnvironment['run'],
  { node = process.execPath, bundle = process.argv[1] ?? '', team = RELEASE_TEAM } = {},
): Promise<void> => {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(INSTALL_MESSAGE)
  const stable = macServiceRuntimePaths(launcher)
  const [runningNode, runningBundle, installedNode, installedBundle, installedLauncher] = await Promise.all([
    realpath(node), realpath(bundle), realpath(stable.node), realpath(stable.bundle), realpath(launcher),
  ])
  const runtime = dirname(installedNode)
  const installation = dirname(dirname(runtime))
  if (runningNode !== installedNode || runningBundle !== installedBundle
    || installedBundle !== join(runtime, 'nessie-executor.cjs')
    || installedNode !== join(installation, 'libexec/runtime', RUNTIME_NODE)
    || installedLauncher !== join(installation, 'bin/nessie-executor')) throw new Error(INSTALL_MESSAGE)
  const facts = await collectExecutorRuntimeFacts(runtime, { runningBundlePath: bundle })
  const verdict = verifyExecutorRuntime({ ...facts, platform: 'darwin' })
  if (!verdict.ok) throw new Error(`The Homebrew runtime failed verification: ${verdict.reason}. Reinstall nessie-executor.`)
  // Pin Developer ID Application, not merely any valid Apple or ad-hoc signature.
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${team}"`
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
  for (const file of [installedNode, join(runtime, 'nessie-executor-native')]) {
    const signature = await run('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, file])
    if (signature.code !== 0) throw new Error('The Homebrew runtime is not signed by Nessie. Reinstall nessie-executor.')
  }
}
