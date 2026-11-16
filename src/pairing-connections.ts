import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { ExecutorPairingClaimSchema, type ExecutorPairingClaim } from '@nessie/executor-protocol'
import { executorApi, type ExecutorApiClient } from './api-client.js'
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

/** A signed fresh connection read decides team identity; display names never do. */
export const findDuplicatePairing = async (
  directory: string, apiBaseUrl: string, claim: ExecutorPairingClaim, connectionRoot?: string,
  api: Pick<ExecutorApiClient, 'pairing'> = executorApi,
): Promise<ExecutorPairingClaim | null> => {
  const teams = await findLocalTeams({ platform: process.platform, home: homedir(), err: () => {
    throw new Error('An existing computer connection could not be checked. Try again after checking its settings.')
  } }, false, connectionRoot ? { teams: [], roots: [connectionRoot] } : undefined)
  for (const team of teams) {
    if (resolve(team.stateDir) === resolve(directory) || team.executorId === claim.executorId
      || new URL(team.state.apiBaseUrl).origin !== new URL(apiBaseUrl).origin) continue
    const payload = { executorId: team.executorId, timestamp: new Date().toISOString() }
    const existing = ExecutorPairingClaimSchema.parse(await api.pairing(team.state.apiBaseUrl, 'connection', {
      ...payload, signature: pairingSignature(team.state.machinePrivateKey, 'connection', payload),
    }))
    if (existing.executorId !== team.executorId) throw new Error('Nessie answered for a different computer connection.')
    if (existing.organization.id === claim.organization.id
      && (existing.team?.id ?? null) === (claim.team?.id ?? null)) {
      return existing
    }
  }
  return null
}