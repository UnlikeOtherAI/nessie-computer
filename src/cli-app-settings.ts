import { join } from 'node:path'

import { CliRefusal, type CliContext } from './cli-output.js'
import { installedMacApp, MAC_APP_BUNDLE_ID } from './cli-team-runner.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'
import { deleteUserValue, readUserString, writeUserString } from './windows-registry.js'

/**
 * The app's two computer-wide settings the command line also controls, kept
 * where the app keeps them so either can change them:
 *
 * - **Open Nessie Computer when I log in** — on a Mac the app's own login item,
 *   which only the app can register, so the app's executable is run with
 *   `--login-item`; on Windows the app's `Run` value, as the installer and the
 *   app write it.
 * - **Restart a team if it stops** — the app's preference (`RestartStoppedConnections`).
 */

type Host = Pick<CliContext, 'platform' | 'run' | 'home'>

const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'NessieExecutorTray'
const WINDOWS_APP_KEY = 'Software\\UnlikeOtherAI\\Nessie Executor'
const RESTART_VALUE = 'RestartStoppedConnections'

const NO_MAC_APP = 'Open at login belongs to the Nessie Computer app, which isn\'t installed on this Mac. '
  + 'Teams the command line runs start when you log in anyway.'
const NO_LINUX_APP = 'Linux has no Nessie Computer app to open at login. Connected teams start at boot.'

/** The value the installer and the Windows app write: the app's own path, quoted. */
export const windowsLoginCommand = (): string => `"${join(packagedRuntimeDirectory(), 'nessie-executor-tray.exe')}"`

const macLoginItem = async (context: Host, argument: 'status' | 'on' | 'off'): Promise<boolean> => {
  const app = await installedMacApp(context)
  if (!app) throw new CliRefusal('LOGIN_ITEM_UNAVAILABLE', NO_MAC_APP)
  const result = await context.run(app.executable, ['--login-item', argument])
  let answer: { enabled?: unknown; error?: unknown } = {}
  try { answer = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as typeof answer } catch { /* refused below */ }
  if (answer.error === 'needsApproval') {
    throw new CliRefusal('LOGIN_ITEM_NEEDS_APPROVAL',
      'macOS needs you to allow Nessie Computer in System Settings → General → Login Items.')
  }
  if (result.code !== 0 || typeof answer.enabled !== 'boolean') {
    throw new CliRefusal('LOGIN_ITEM_FAILED', 'macOS didn\'t change whether Nessie Computer opens at login. Try again.')
  }
  return answer.enabled
}

export const loginItemEnabled = async (context: Host): Promise<boolean> => {
  if (context.platform === 'darwin') return macLoginItem(context, 'status')
  if (context.platform === 'win32') {
    const value = await readUserString(context.run, RUN_KEY, RUN_VALUE)
    return value !== null && value.toLowerCase() === windowsLoginCommand().toLowerCase()
  }
  throw new CliRefusal('LOGIN_ITEM_UNAVAILABLE', NO_LINUX_APP)
}

export const setLoginItem = async (context: Host, enabled: boolean): Promise<boolean> => {
  if (context.platform === 'darwin') return macLoginItem(context, enabled ? 'on' : 'off')
  if (context.platform !== 'win32') throw new CliRefusal('LOGIN_ITEM_UNAVAILABLE', NO_LINUX_APP)
  if (enabled) await writeUserString(context.run, RUN_KEY, RUN_VALUE, windowsLoginCommand())
  else await deleteUserValue(context.run, RUN_KEY, RUN_VALUE)
  return loginItemEnabled(context)
}

/** The app's "Restart a team if it stops": on unless the person turned it off. */
export const appAutoRestartEnabled = async (context: Host): Promise<boolean> => {
  if (context.platform === 'win32') return await readUserString(context.run, WINDOWS_APP_KEY, RESTART_VALUE) !== '0'
  const result = await context.run('/usr/bin/defaults', ['read', MAC_APP_BUNDLE_ID, RESTART_VALUE])
  return result.code !== 0 || result.stdout.trim() !== '0'
}

export const setAppAutoRestart = async (context: Host, enabled: boolean): Promise<void> => {
  if (context.platform === 'win32') {
    await writeUserString(context.run, WINDOWS_APP_KEY, RESTART_VALUE, enabled ? '1' : '0')
    return
  }
  const result = await context.run('/usr/bin/defaults', ['write', MAC_APP_BUNDLE_ID, RESTART_VALUE, '-bool', String(enabled)])
  if (result.code !== 0) throw new CliRefusal('SETTING_NOT_SAVED', 'macOS didn\'t save the restart setting. Try again.')
}
