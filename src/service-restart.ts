import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import type { ExecutorServiceEnvironment } from './service-environment.js'

/**
 * Whether a team's CLI service starts its daemon again when it stops without
 * being asked to — the CLI's counterpart of the apps' "Restart a connection if
 * it stops". Kept beside the pairing; absent means on, which is how every CLI
 * service behaved before the switch existed. launchd reads it as the agent's
 * `KeepAlive`; systemd as a drop-in that turns the unit template's
 * `Restart=on-failure` off.
 */
const pathOf = (stateDir: string): string => join(stateDir, 'service-restart.json')

export const serviceAutoRestartEnabled = async (stateDir: string): Promise<boolean> => {
  try {
    const value: unknown = JSON.parse(await readFile(pathOf(stateDir), 'utf8'))
    return !(value && typeof value === 'object' && (value as { enabled?: unknown }).enabled === false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

export const setServiceAutoRestart = async (stateDir: string, enabled: boolean): Promise<void> => {
  await replaceOwnerOnlyJson(pathOf(stateDir), { enabled })
}

/** The user unit directory systemd reads; `$XDG_CONFIG_HOME` moves it. */
const userUnitDirectory = (home: string): string => join(
  process.env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user',
)

export const linuxRestartDropIn = (home: string, executorId: string): string => join(
  userUnitDirectory(home), `nessie-executor@${executorId}.service.d`, 'restart.conf',
)

/**
 * Writes the drop-in when restarting is off and removes it when it is on. The
 * user manager reads it at its next `daemon-reload`, which every caller runs;
 * the running daemon is left alone.
 */
export const writeLinuxServiceRestart = async (
  environment: Pick<ExecutorServiceEnvironment, 'home'>, executorId: string, enabled: boolean,
): Promise<void> => {
  const path = linuxRestartDropIn(environment.home, executorId)
  if (enabled) {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, '[Service]\nRestart=no\n', { mode: 0o644 })
}
