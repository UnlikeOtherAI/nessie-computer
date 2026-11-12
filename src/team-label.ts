import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { assertOwnerOnlyStatePath } from './state-security.js'

/**
 * What a team is called, kept in the team's own folder as `team-label.json`
 * so every surface can name it without asking anyone: the window's team list
 * and cards, both menus, notifications and the command line (contract §13).
 *
 * It is display metadata and nothing else. It never grants, narrows or proves
 * access, nothing sends it back to Nessie, and losing it costs only a name
 * until the next refresh. It is written from the pairing claim when a team
 * connects and from every answer Nessie gives to the batched team-names read
 * (`team-names.ts`); a refresh that fails or leaves a team out writes
 * nothing, so a known name is never blanked.
 *
 * The record is not secret, so the Windows supervisors read it directly the
 * way they read `owner-pause.json` (`windows-common/src/team_label.rs`).
 */
export type TeamLabel = {
  organizationName: string
  /** Null for a team connected for its whole organisation rather than one team. */
  teamName: string | null
  /** The Nessie server the names came from: two equal labels are told apart by its host. */
  apiBaseUrl: string
  /** When Nessie last gave these names; the command line asks again once it is an hour old. */
  checkedAt: string
}

export type TeamDisplayNames = Pick<TeamLabel, 'organizationName' | 'teamName'>

export const TEAM_LABEL_FILE = 'team-label.json'

/** How long names count as current before the command line asks Nessie again. */
export const TEAM_LABEL_FRESH_MS = 60 * 60 * 1_000

export const teamLabelPath = (stateDir: string): string => join(stateDir, TEAM_LABEL_FILE)

const NAME_LIMIT = 160

const displayName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= NAME_LIMIT ? trimmed : null
}

/** Names Nessie gave, held to what a label may show; null when there is no organisation name. */
export const teamDisplayNames = (
  value: { organizationName?: unknown; teamName?: unknown },
): TeamDisplayNames | null => {
  const organizationName = displayName(value.organizationName)
  return organizationName ? { organizationName, teamName: displayName(value.teamName) } : null
}

/** The team's saved label; null when it has never had one, or when the file can't be read as one. */
export const readTeamLabel = async (stateDir: string): Promise<TeamLabel | null> => {
  const path = teamLabelPath(stateDir)
  let parsed: Partial<TeamLabel>
  try {
    await assertOwnerOnlyStatePath(path, 'file')
    parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<TeamLabel>
  } catch {
    return null
  }
  const names = parsed && typeof parsed === 'object' ? teamDisplayNames(parsed) : null
  if (!names || typeof parsed.apiBaseUrl !== 'string' || typeof parsed.checkedAt !== 'string') return null
  return { ...names, apiBaseUrl: parsed.apiBaseUrl, checkedAt: parsed.checkedAt }
}

/** Saves the names Nessie just gave for this team, replacing the record atomically. */
export const saveTeamLabel = async (
  stateDir: string, names: TeamDisplayNames, apiBaseUrl: string, now: () => Date = () => new Date(),
): Promise<TeamLabel> => {
  const checked = teamDisplayNames(names)
  if (!checked) throw new Error('A team label needs an organisation name.')
  const label: TeamLabel = { ...checked, apiBaseUrl, checkedAt: now().toISOString() }
  await replaceOwnerOnlyJson(teamLabelPath(stateDir), label)
  return label
}

/** Whether the command line should ask Nessie again: never named, named by another server, or an hour old. */
export const teamLabelStale = (label: TeamLabel | null, apiBaseUrl: string, now: Date = new Date()): boolean => (
  !label || label.apiBaseUrl !== apiBaseUrl || !(now.getTime() - Date.parse(label.checkedAt) < TEAM_LABEL_FRESH_MS)
)
