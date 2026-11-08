import {
  EXECUTOR_DAEMON_TEAMS_MAXIMUM, ExecutorDaemonTeamsRequestSchema, ExecutorDaemonTeamsResponseSchema,
  ExecutorPairingClaimSchema,
} from '@nessie/executor-protocol'

import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import { pairingSignature } from './pairing-code.js'
import type { ExecutorLocalState } from './state-store.js'
import { saveTeamLabel, teamDisplayNames, type TeamDisplayNames, type TeamLabel } from './team-label.js'

/**
 * Reads what this computer's teams are called and saves each team's label in
 * its folder (`team-label.json`, `team-label.ts`). One request per Nessie
 * server carries every team paired with it (`POST /api/executor-daemon/teams`,
 * `executor-teams.ts` in the protocol), each entry signed with that team's own
 * machine key: no person, session or daemon connection is involved, so a
 * stopped team is named as readily as a running one.
 *
 * A Nessie from before that route answers 404. Then, and only then, each of
 * its teams is read through the older signed `POST /api/executor-pairing/connection`,
 * which some servers still refuse without a person's session; such a refusal
 * leaves the saved label as it was.
 *
 * Nothing here ever clears or blanks a label: a server that can't be reached,
 * refuses, or leaves a team out of its answer changes nothing on disk.
 */

export type TeamNameSource = {
  stateDir: string
  state: Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey'>
}

export type TeamNamesApi = Pick<ExecutorApiClient, 'teams' | 'pairing'>

type Dependencies = { api?: TeamNamesApi; now?: () => Date }

const batches = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size))
  return result
}

/** A Nessie that has no batched route at all, rather than one that refused this request. */
const routeMissing = (error: unknown): boolean => error instanceof ExecutorApiError && error.status === 404

const entryFor = (source: TeamNameSource, now: Date) => {
  const payload = { executorId: source.state.executorId, observedAt: now.toISOString() }
  return { ...payload, signature: signExecutorDaemonPayload(source.state.machinePrivateKey, 'teams', payload) }
}

/** One batch's names from the batched route, by executor id; entries Nessie left out are absent. */
const askBatch = async (
  api: TeamNamesApi, apiBaseUrl: string, sources: readonly TeamNameSource[], now: Date,
): Promise<Map<string, TeamDisplayNames>> => {
  const request = ExecutorDaemonTeamsRequestSchema.parse({ entries: sources.map((source) => entryFor(source, now)) })
  const answer = ExecutorDaemonTeamsResponseSchema.parse(await api.teams(apiBaseUrl, request))
  const asked = new Set(sources.map((source) => source.state.executorId))
  const names = new Map<string, TeamDisplayNames>()
  for (const team of answer.teams) {
    const checked = teamDisplayNames(team)
    if (checked && asked.has(team.executorId)) names.set(team.executorId, checked)
  }
  return names
}

/** A team's names from an older Nessie, through the connection read it already answers. */
const askConnection = async (
  api: TeamNamesApi, source: TeamNameSource, now: Date,
): Promise<TeamDisplayNames | null> => {
  const payload = { executorId: source.state.executorId, timestamp: now.toISOString() }
  const claim = ExecutorPairingClaimSchema.parse(await api.pairing(source.state.apiBaseUrl, 'connection', {
    ...payload, signature: pairingSignature(source.state.machinePrivateKey, 'connection', payload),
  }))
  if (claim.executorId !== source.state.executorId) return null
  return teamDisplayNames({ organizationName: claim.organization.name, teamName: claim.team?.name ?? null })
}

/** Every batch for one server: the batched route, or each team's connection read on a Nessie without it. */
const askServer = async (
  api: TeamNamesApi, apiBaseUrl: string, sources: readonly TeamNameSource[], now: Date,
): Promise<Map<string, TeamDisplayNames>> => {
  const names = new Map<string, TeamDisplayNames>()
  for (const batch of batches(sources, EXECUTOR_DAEMON_TEAMS_MAXIMUM)) {
    try {
      for (const [executorId, found] of await askBatch(api, apiBaseUrl, batch, now)) names.set(executorId, found)
    } catch (error) {
      if (!routeMissing(error)) return names
      for (const source of sources) {
        const found = await askConnection(api, source, now).catch(() => null)
        if (found) names.set(source.state.executorId, found)
      }
      return names
    }
  }
  return names
}

/**
 * Asks Nessie for every listed team's names and saves each answer as that
 * team's label. Answers the labels it saved, by executor id; a team missing
 * from the result kept whatever label it had.
 */
export const refreshTeamNames = async (
  sources: readonly TeamNameSource[], dependencies: Dependencies = {},
): Promise<Map<string, TeamLabel>> => {
  const api = dependencies.api ?? executorApi
  const now = dependencies.now ?? (() => new Date())
  const servers = new Map<string, TeamNameSource[]>()
  for (const source of sources) {
    const listed = servers.get(source.state.apiBaseUrl) ?? []
    if (!listed.some((other) => other.state.executorId === source.state.executorId)) listed.push(source)
    servers.set(source.state.apiBaseUrl, listed)
  }
  const saved = new Map<string, TeamLabel>()
  await Promise.all([...servers].map(async ([apiBaseUrl, listed]) => {
    const names = await askServer(api, apiBaseUrl, listed, now()).catch(() => new Map<string, TeamDisplayNames>())
    for (const source of listed) {
      const found = names.get(source.state.executorId)
      if (!found) continue
      const label = await saveTeamLabel(source.stateDir, found, apiBaseUrl, now).catch(() => null)
      if (label) saved.set(source.state.executorId, label)
    }
  }))
  return saved
}
