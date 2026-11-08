import { dirname, join, resolve } from 'node:path'

import { otherSyncTeamFolders } from './config.js'
import { nameKey, teamFolderSegment } from './path-mapping.js'

/**
 * Where a team's files go under the main folder (path mapping rule 8): several
 * teams share one main folder, each in `<Organisation>/<Team>`. The folder is
 * named once, when the engine first syncs, and then fixed; a sync named before
 * this layout keeps its one-segment `<Team>` folder.
 *
 * The one rule that keeps teams apart: a new team folder never is, holds or
 * sits inside another sync's team folder on this computer. On a clash the
 * executor's short tag goes on the team segment, as it always has; when the
 * clash is the organisation folder itself (an older sync's `<Team>` folder of
 * the same name), on the organisation segment.
 */

export type TeamFolderNames = { organizationName: string; teamName: string }

/** The names to try, in order: plain, tagged team, tagged organisation, both tagged. */
export const teamFolderCandidates = (names: TeamFolderNames, executorId: string): string[] => {
  const organization = (tagged: boolean) => teamFolderSegment(names.organizationName, executorId, tagged)
  const team = (tagged: boolean) => teamFolderSegment(names.teamName, executorId, tagged)
  return [
    `${organization(false)}/${team(false)}`,
    `${organization(false)}/${team(true)}`,
    `${organization(true)}/${team(false)}`,
    `${organization(true)}/${team(true)}`,
  ]
}

const keys = (path: string): string[] => resolve(path).split(/[\\/]+/u).filter(Boolean).map(nameKey)

/**
 * True when one folder is the other or holds it, names compared as sibling
 * names are (`nameKey`: case and normalisation folded on every platform).
 */
export const foldersOverlap = (a: string, b: string): boolean => {
  const [left, right] = [keys(a), keys(b)]
  return left.slice(0, Math.min(left.length, right.length)).every((key, index) => key === right[index])
}

/** The team folder a new sync in `root` takes: the first candidate no other sync's folder overlaps. */
export const chooseTeamFolder = async (root: string, names: TeamFolderNames, executorId: string): Promise<string> => {
  const candidates = teamFolderCandidates(names, executorId)
  for (const candidate of candidates) {
    const path = join(root, ...candidate.split('/'))
    const taken = await otherSyncTeamFolders(dirname(path), executorId)
    if (!taken.some((folder) => foldersOverlap(folder, path))) return candidate
  }
  return candidates.at(-1)!
}
