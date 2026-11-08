import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'

import { teamLocations } from '../cli-teams.js'
import { defaultFolderSyncRoot, loadFolderSyncConfig, markerForSync } from './config.js'
import { lstatOrNull } from './local-fs.js'

/**
 * One main folder by default: every team's Documents tab offers the folder
 * another team on this computer already syncs into, so several teams share
 * it, each in its own team folder. The first team to sync there wins (its
 * marker's `createdAt`); with none, `~/Documents/Nessie`.
 */

/** The state folders of the other teams on this computer: beside this one, and where the apps keep theirs. */
const otherTeamStateDirs = async (stateDir: string, home: string): Promise<string[]> => {
  const locations = teamLocations(process.platform, home)
  const parents = [dirname(resolve(stateDir)), ...locations.roots]
  const found = new Set(locations.teams.map((dir) => resolve(dir)))
  for (const parent of parents) {
    for (const name of await readdir(parent).catch(() => [] as string[])) found.add(resolve(parent, name))
  }
  found.delete(resolve(stateDir))
  return [...found].sort()
}

export const suggestedMainFolder = async (stateDir: string, home = homedir()): Promise<string> => {
  const chosen: Array<{ root: string; since: string }> = []
  for (const dir of await otherTeamStateDirs(stateDir, home)) {
    const config = await loadFolderSyncConfig(dir).catch(() => null)
    if (!config?.root || !config.syncId || (await lstatOrNull(config.root))?.type !== 'directory') continue
    const marker = await markerForSync(config.root, config.syncId)
    if (marker) chosen.push({ root: config.root, since: marker.createdAt })
  }
  chosen.sort((a, b) => a.since.localeCompare(b.since))
  return chosen[0]?.root ?? defaultFolderSyncRoot(home)
}

