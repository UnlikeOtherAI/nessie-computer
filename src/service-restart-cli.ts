import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertExecutorIdentifier, createExecutorServiceEnvironment, executorServiceStateRoot,
  type ExecutorServiceEnvironment,
} from './service-environment.js'
import { createMacServiceEnvironment, enableMacExecutorService, macLaunchAgent } from './service-macos.js'
import { serviceAutoRestartEnabled, setServiceAutoRestart, writeLinuxServiceRestart } from './service-restart.js'

const USAGE = 'Usage: nessie-computer autorestart <team-id> [on|off]'

export const WINDOWS_AUTORESTART = 'On Windows the Nessie Computer app runs the teams you add here. '
  + 'Use nessie-computer settings auto-restart, or Restart a team if it stops in the app\'s Settings.'

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type RestartEnvironment = ExecutorServiceEnvironment & {
  /** Re-registers an enabled macOS agent so launchd reads its new `KeepAlive`. */
  reapplyMacService?: (executorId: string) => Promise<void>
}

const reapplyMacService = async (executorId: string): Promise<void> => {
  const environment = createMacServiceEnvironment()
  // Only an agent that was enabled is re-registered; otherwise `enable` applies the setting later.
  if (await exists(macLaunchAgent(executorId, environment).path)) {
    await enableMacExecutorService({ executorId }, environment)
  }
}

/**
 * `nessie-computer autorestart <team-id> [on|off]` — whether that team's
 * service starts its daemon again after it stops without being asked to. With
 * no value it says which. A change is applied at once: launchd re-registers an
 * enabled agent (restarting its daemon once), and systemd reloads the drop-in.
 */
export const runServiceRestartCli = async (
  args: string[],
  environment: RestartEnvironment = createExecutorServiceEnvironment(),
): Promise<boolean> => {
  if (args[0] !== 'autorestart') return false
  const [, id, choice, ...rest] = args
  if (!id || id.startsWith('--') || rest.length > 0 || (choice !== undefined && choice !== 'on' && choice !== 'off')) {
    throw new Error(USAGE)
  }
  if (environment.platform === 'win32') throw new Error(WINDOWS_AUTORESTART)
  if (environment.platform !== 'darwin' && environment.platform !== 'linux') {
    throw new Error('Background services need macOS launchd or Linux systemd.')
  }
  const executorId = assertExecutorIdentifier(id)
  const stateDir = join(executorServiceStateRoot(environment.home), executorId)
  await environment.loadPairedState(stateDir)
  if (choice !== undefined) {
    const enabled = choice === 'on'
    await setServiceAutoRestart(stateDir, enabled)
    if (environment.platform === 'darwin') {
      await (environment.reapplyMacService ?? reapplyMacService)(executorId)
    } else {
      await writeLinuxServiceRestart(environment, executorId, enabled)
      const reload = await environment.run('systemctl', ['--user', 'daemon-reload'])
      if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload exited with status ${reload.code}.`)
    }
  }
  const enabled = await serviceAutoRestartEnabled(stateDir)
  environment.write(`team ${executorId}: autorestart=${enabled ? 'on' : 'off'}`)
  return true
}
