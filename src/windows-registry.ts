import { CliRefusal, type HostRun } from './cli-output.js'

/**
 * Values under `HKEY_CURRENT_USER` that the Windows app keeps, read and
 * written with Windows' own `reg` command so the app and the command line
 * change the same setting.
 */

const REG = 'reg.exe'

const keyPath = (key: string): string => `HKCU\\${key}`

/** A string value, or `null` when it isn't set. */
export const readUserString = async (run: HostRun, key: string, name: string): Promise<string | null> => {
  const result = await run(REG, ['query', keyPath(key), '/v', name])
  if (result.code === 1) return null
  if (result.code !== 0) throw new CliRefusal('WINDOWS_SETTING_UNREADABLE', 'Windows didn\'t let Nessie Computer read this setting.')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*?)\\s*$`, 'mu').exec(result.stdout)
  return found ? found[1]! : null
}

export const writeUserString = async (run: HostRun, key: string, name: string, value: string): Promise<void> => {
  const result = await run(REG, ['add', keyPath(key), '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
  if (result.code !== 0) throw new CliRefusal('WINDOWS_SETTING_NOT_SAVED', 'Windows didn\'t let Nessie Computer change this setting.')
}

/** Removes a value; one that isn't there is already removed. */
export const deleteUserValue = async (run: HostRun, key: string, name: string): Promise<void> => {
  if (await readUserString(run, key, name) === null) return
  const result = await run(REG, ['delete', keyPath(key), '/v', name, '/f'])
  if (result.code !== 0) throw new CliRefusal('WINDOWS_SETTING_NOT_SAVED', 'Windows didn\'t let Nessie Computer change this setting.')
}
