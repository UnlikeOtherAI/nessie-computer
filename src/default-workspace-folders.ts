import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

import type { ExecutorWorkspaceFolder } from './workspace-folders.js'

/** What the defaults read from the host; injected platforms also select path semantics. */
export type DefaultFolderProbe = {
  environment: Record<string, string | undefined>
  home: string
  platform: NodeJS.Platform
  isDirectory: (path: string) => Promise<boolean>
  makeDirectory: (path: string) => Promise<void>
  readText: (path: string) => Promise<string | null>
}

const hostProbe = (): DefaultFolderProbe => ({
  environment: process.env,
  home: homedir(),
  platform: process.platform,
  isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() === true,
  makeDirectory: async (path) => { await mkdir(path, { recursive: true }) },
  readText: (path) => readFile(path, 'utf8').catch(() => null),
})

const pathFor = (probe: DefaultFolderProbe) => probe.platform === 'win32' ? win32 : posix

/**
 * The folder xdg-user-dirs names for public sharing. A disabled entry points at
 * the home directory itself, which is not a shared folder and would contain the
 * Nessie folder, so it counts as none.
 */
const linuxPublicShare = async (probe: DefaultFolderProbe): Promise<string | null> => {
  const path = pathFor(probe)
  const configHome = probe.environment.XDG_CONFIG_HOME || path.join(probe.home, '.config')
  const text = await probe.readText(path.join(configHome, 'user-dirs.dirs'))
  const configured = text?.match(/^XDG_PUBLICSHARE_DIR="([^"]*)"\s*$/mu)?.[1]
  const expanded = configured === undefined
    ? path.join(probe.home, 'Public')
    : configured.replace(/^\$HOME(?=\/|$)/u, probe.home)
  if (!path.isAbsolute(expanded) || path.resolve(expanded) === path.resolve(probe.home)) return null
  return path.resolve(expanded)
}

/** The folder each platform shares between its accounts, where it has one. */
export const platformSharedFolder = async (probe: DefaultFolderProbe): Promise<string | null> => {
  if (probe.platform === 'darwin') return '/Users/Shared'
  if (probe.platform === 'win32') return probe.environment.PUBLIC || null
  if (probe.platform === 'linux') return linuxPublicShare(probe)
  return null
}

/**
 * What a new pairing may reach when nobody chose a folder: `nessie` — a Nessie
 * folder in the home directory, created on first use — and `shared`, the
 * platform's shared folder (/Users/Shared, %PUBLIC%, or the XDG public-share
 * folder). A Linux account without that folder gets the Nessie folder alone.
 * Both remain ordinary folder entries the owner can remove or add to locally.
 */
export const defaultExecutorWorkspaceFolders = async (
  probe: DefaultFolderProbe = hostProbe(),
): Promise<ExecutorWorkspaceFolder[]> => {
  const nessie = pathFor(probe).join(probe.home, 'Nessie')
  await probe.makeDirectory(nessie)
  const shared = await platformSharedFolder(probe)
  return [
    { name: 'nessie', path: nessie },
    ...(shared && await probe.isDirectory(shared) ? [{ name: 'shared', path: shared }] : []),
  ]
}
