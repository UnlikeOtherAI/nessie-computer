import { ZodError } from 'zod'

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
 * The batched read is always asked first. When it gives no well-formed answer
 * — the route is missing (404), refused (401 `AUTH_REQUIRED` is how a Nessie
 * from before it answers an unknown route; 403, 405), failed (5xx),
 * unreachable, or answered with something that is not well formed — each of
 * that batch's teams is read through the older signed
 * `POST /api/executor-pairing/connection`. Whichever read names a team, its
 * label is written.
 *
 * Nothing here ever clears or blanks a label: a team no read names keeps
 * whatever it had. Every failure is logged once per refresh, by its HTTP
 * status and error code only: never a body, a signature or a key.
 */

export type TeamNameSource = {
  stateDir: string
  state: Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey'>
}

export type TeamNamesApi = Pick<ExecutorApiClient, 'teams' | 'pairing'>

type Log = (message: string) => void

/** `log` hears each failure of a refresh once; the daemon's, tray's and service's logs by default (standard error). */
type Dependencies = { api?: TeamNamesApi; now?: () => Date; log?: Log }

const standardError: Log = (message) => { console.error(`[nessie-executor] ${message}`) }

const batches = <T>(items: readonly T[], size: number): T[][] => {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size))
  return result
}

/** Why a read named nobody, for a log: Nessie's status and error code, never its body. */
export const teamNamesFailure = (error: unknown): string => {
  if (error instanceof ExecutorApiError) {
    const said = [error.status === undefined ? undefined : `HTTP ${error.status}`, error.code].filter(Boolean)
    return said.length ? said.join(' ') : 'no answer'
  }
  if (error instanceof ZodError || error instanceof SyntaxError) return 'an answer that is not well formed'
  return error instanceof Error ? error.name : 'an unknown failure'
}

const hostOf = (apiBaseUrl: string): string => {
  try { return new URL(apiBaseUrl).host } catch { return apiBaseUrl }
}

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

/** A team's names through the connection read every Nessie answers for a signed team. */
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

/**
 * Every team's names on one server: each batch through the batched route, and
 * the teams of every batch it did not answer well formed through their own
 * connection reads, all at once, so a slow Nessie costs two request deadlines
 * rather than one a team. A team a well-formed answer left out is not asked
 * again: that Nessie has the route and did not verify it.
 */
const askServer = async (
  api: TeamNamesApi, apiBaseUrl: string, sources: readonly TeamNameSource[], now: Date, log: Log,
): Promise<Map<string, TeamDisplayNames>> => {
  const host = hostOf(apiBaseUrl)
  const names = new Map<string, TeamDisplayNames>()
  const unanswered: TeamNameSource[] = []
  for (const batch of batches(sources, EXECUTOR_DAEMON_TEAMS_MAXIMUM)) {
    try {
      for (const [executorId, found] of await askBatch(api, apiBaseUrl, batch, now)) names.set(executorId, found)
    } catch (error) {
      log(`team names: ${host} did not answer the batched read (${teamNamesFailure(error)}); asking each team.`)
      unanswered.push(...batch)
    }
  }
  await Promise.all(unanswered.map(async (source) => {
    try {
      const found = await askConnection(api, source, now)
      if (found) names.set(source.state.executorId, found)
      else log(`team names: ${host} answered for another team than ${source.state.executorId}.`)
    } catch (error) {
      log(`team names: ${host} did not name team ${source.state.executorId} (${teamNamesFailure(error)}).`)
    }
  }))
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
  const log = dependencies.log ?? standardError
  const servers = new Map<string, TeamNameSource[]>()
  for (const source of sources) {
    const listed = servers.get(source.state.apiBaseUrl) ?? []
    if (!listed.some((other) => other.state.executorId === source.state.executorId)) listed.push(source)
    servers.set(source.state.apiBaseUrl, listed)
  }
  const saved = new Map<string, TeamLabel>()
  await Promise.all([...servers].map(async ([apiBaseUrl, listed]) => {
    const names = await askServer(api, apiBaseUrl, listed, now(), log)
    for (const source of listed) {
      const found = names.get(source.state.executorId)
      if (!found) continue
      try {
        saved.set(source.state.executorId, await saveTeamLabel(source.stateDir, found, apiBaseUrl, now))
      } catch (error) {
        log(`team names: the label for team ${source.state.executorId} was not saved (${
          (error as NodeJS.ErrnoException).code ?? teamNamesFailure(error)}).`)
      }
    }
  }))
  return saved
}
