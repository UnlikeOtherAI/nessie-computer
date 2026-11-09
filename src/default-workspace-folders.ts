import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

import type { ExecutorWorkspaceFolder } from './workspace-folders.js'

/** What the default reads from the host; an injected platform also selects path semantics. */
export type DefaultFolderProbe = {
  home: string
  platform: NodeJS.Platform
  makeDirectory: (path: string) => Promise<void>
}

const hostProbe = (): DefaultFolderProbe => ({
  home: homedir(),
  platform: process.platform,
  makeDirectory: async (path) => { await mkdir(path, { recursive: true }) },
})

/**
 * What a new pairing may reach when nobody chose a folder: `nessie`, a Nessie
 * folder in the home directory, created on first use. It is one folder on
 * purpose: a guest VM mounts exactly one, so a second default would make the
 * guest browser, sandboxed commands and `coding.launch` refuse with
 * `EXECUTOR_GUEST_SINGLE_FOLDER_REQUIRED` from the first minute. The owner can
 * add folders locally, knowing that trade.
 */
export const defaultExecutorWorkspaceFolders = async (
  probe: DefaultFolderProbe = hostProbe(),
): Promise<ExecutorWorkspaceFolder[]> => {
  const nessie = (probe.platform === 'win32' ? win32 : posix).join(probe.home, 'Nessie')
  await probe.makeDirectory(nessie)
  return [{ name: 'nessie', path: nessie }]
}
