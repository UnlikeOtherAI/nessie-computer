import { isAbsolute, join } from 'node:path'

import { CliRefusal, type HostRun } from './cli-output.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'

/**
 * The Windows service runs under its own account, which can read none of a
 * person's folders. Before it may use one, Windows asks an administrator once
 * (UAC), exactly as it does when the folder is chosen in the Windows app: the
 * app's own `--grant-workspace` mode gives the service read access to that
 * folder, and records this Windows account so the service admits it later.
 * The folder travels in an environment variable, never inside the command text.
 */

const TRAY = 'nessie-executor-tray.exe'
const CANCELLED = 1223

const SCRIPT = '$ErrorActionPreference = \'Stop\'; try { '
  + '$grant = Start-Process -FilePath $env:NESSIE_COMPUTER_APP -Verb RunAs -WindowStyle Hidden -Wait -PassThru '
  + '-ArgumentList (\'--grant-workspace "\' + $env:NESSIE_COMPUTER_FOLDER + \'"\'); exit $grant.ExitCode '
  + `} catch { exit ${CANCELLED} }`

export const grantServiceFolder = async (run: HostRun, folder: string): Promise<void> => {
  if (!isAbsolute(folder) || folder.includes('"')) {
    throw new CliRefusal('FOLDER_NOT_GRANTED', `${folder} isn't a folder the Nessie Computer service can be given.`)
  }
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    env: { NESSIE_COMPUTER_APP: join(packagedRuntimeDirectory(), TRAY), NESSIE_COMPUTER_FOLDER: folder },
  })
  if (result.code === 0) return
  throw new CliRefusal('FOLDER_NOT_GRANTED', result.code === CANCELLED
    ? `The Nessie Computer service needs permission to read ${folder}. Windows asked, and it wasn't given, so nothing changed.`
    : `Nessie Computer couldn't give its service access to ${folder}, so nothing changed.`)
}
