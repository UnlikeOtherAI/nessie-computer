import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ExecutorPairingClaimSchema, type ExecutorPairingClaim } from '@nessie/executor-protocol'
import { executorApi, ExecutorApiError, type ExecutorApiClient } from './api-client.js'
import { findLocalTeams } from './cli-teams.js'
import { executorServiceStateRoot } from './service-environment.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'
import { acquireExecutorProcessLease } from './process-lease.js'
import { pairingSignature } from './pairing-proof.js'

/** One activation across all connection folders held by this OS account. */
export const acquirePairingActivation = async (connectionRoot?: string) => {
  const root = connectionRoot ?? executorServiceStateRoot(homedir())
  await ensureOwnerOnlyStateDirectory(root)
  return acquireExecutorProcessLease(root, 'pairing-activation.pid')
}

export type LocalPairingConnection = {
  claim: ExecutorPairingClaim
  authorizeReuse: (payload: Record<string, unknown>) => string
}

/**
 * Nessie answered this connection's own signed read with a refusal: it is
 * revoked (410), unknown to that server, or in a team that no longer exists.
 * None of those is a working connection to the team being added, which Nessie
 * has just named, so it never holds another team back. A read nobody answered
 * (a network failure, 5xx, a rate limit or timeout) decides nothing.
 */
const refusedOutright = (error: unknown): boolean => error instanceof ExecutorApiError
  && typeof error.status === 'number' && error.status >= 400 && error.status < 500
  && error.status !== 408 && error.status !== 429

/** A signed fresh connection read decides team identity; display names never do. */
const findConnection = async (
  directory: string, apiBaseUrl: string, matches: (claim: ExecutorPairingClaim) => boolean,
  connectionRoot?: string, api: Pick<ExecutorApiClient, 'pairing'> = executorApi, onlyExecutorId?: string,
): Promise<LocalPairingConnection | null> => {
  // A folder whose settings cannot be read cannot run a team or prove one, so it is not a connection to reuse.
  const teams = await findLocalTeams({ platform: process.platform, home: homedir(), err: () => undefined },
    false, connectionRoot ? { teams: [], roots: [connectionRoot] } : undefined)
  for (const team of teams) {
    if (resolve(team.stateDir) === resolve(directory) || onlyExecutorId && team.executorId !== onlyExecutorId
      || new URL(team.state.apiBaseUrl).origin !== new URL(apiBaseUrl).origin) continue
    const payload = { executorId: team.executorId, timestamp: new Date().toISOString() }
    let existing: ExecutorPairingClaim
    try {
      existing = ExecutorPairingClaimSchema.parse(await api.pairing(team.state.apiBaseUrl, 'connection', {
        ...payload, signature: pairingSignature(team.state.machinePrivateKey, 'connection', payload),
      }))
    } catch (error) {
      if (refusedOutright(error)) continue
      throw error
    }
    if (existing.executorId !== team.executorId) throw new Error('Nessie answered for a different computer connection.')
    if (matches(existing)) return { claim: existing,
      authorizeReuse: payload => pairingSignature(team.state.machinePrivateKey, 'reuse', payload) }
  }
  return null
}
export const findDuplicatePairing = (
  directory: string, apiBaseUrl: string, claim: ExecutorPairingClaim, connectionRoot?: string,
  api: Pick<ExecutorApiClient, 'pairing'> = executorApi,
): Promise<LocalPairingConnection | null> => findConnection(directory, apiBaseUrl, existing =>
  existing.executorId !== claim.executorId && existing.organization.id === claim.organization.id
    && (existing.team?.id ?? null) === (claim.team?.id ?? null), connectionRoot, api)

export const findReusedPairing = (
  directory: string, apiBaseUrl: string, executorId: string, connectionRoot?: string,
  api: Pick<ExecutorApiClient, 'pairing'> = executorApi,
): Promise<LocalPairingConnection | null> => findConnection(directory, apiBaseUrl,
  existing => existing.executorId === executorId, connectionRoot, api, executorId)
