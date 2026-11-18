import { isAbsolute, join } from 'node:path'

import { CliRefusal, type HostRun } from './cli-output.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'

/** The installed tray owns UAC, service verification and the elevated result protocol. */
const request = async (run: HostRun, args: string[], code: string): Promise<void> => {
  const result = await run(join(packagedRuntimeDirectory(), 'nessie-executor-tray.exe'), args)
  if (result.code !== 0) throw new CliRefusal(code,
    result.stderr.trim() || 'Could not complete Windows approval. Repair or update Nessie Computer and try again.')
}

export const ensureServiceAccess = (run: HostRun): Promise<void> =>
  request(run, ['--request-service-access'], 'SERVICE_ACCESS_FAILED')

export const grantServiceFolder = async (run: HostRun, folder: string): Promise<void> => {
  if (!isAbsolute(folder) || folder.includes('"')) {
    throw new CliRefusal('FOLDER_NOT_GRANTED', 'Choose an absolute folder path.')
  }
  await request(run, ['--request-workspace-access', folder], 'FOLDER_NOT_GRANTED')
}
