import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'

import {
  canonicalExecutorPayload, EXECUTOR_DAEMON_TEAMS_SIGNATURE_DOMAIN, ExecutorDaemonTeamsRequestSchema,
} from '@nessie/executor-protocol'

import { ExecutorApiError } from '../../src/api-client.js'
import type { TeamNamesApi } from '../../src/team-names.js'

export type FakeNames = { organizationName: string; teamName: string | null }

/**
 * A stand-in Nessie for team names. It answers the batched
 * `POST /api/executor-daemon/teams` from `names`, checking every entry's
 * signature against the team's machine key the way Nessie must, or — as a
 * Nessie from before that route — answers 404 there and names teams through
 * `POST /api/executor-pairing/connection`, which may also refuse as an older
 * server does without a person's session.
 */
export const fakeTeamNames = (options: {
  names: Map<string, FakeNames> | Record<string, FakeNames>
  /** executorId → the team's machine private key (pkcs8 DER, base64url), for verifying signatures. */
  keys?: Map<string, string>
  old?: boolean
  refuseConnection?: boolean
  unreachable?: boolean
}) => {
  const names = options.names instanceof Map ? options.names : new Map(Object.entries(options.names))
  const calls: Array<{ route: 'teams' | 'connection'; baseUrl: string; executorIds: string[] }> = []
  const verifySigned = (executorId: string, domain: string, payload: Record<string, unknown>, signature: string) => {
    const key = options.keys?.get(executorId)
    if (!key) return
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' }))
    assert.ok(verify(null, Buffer.from(canonicalExecutorPayload(domain, payload)), publicKey,
      Buffer.from(signature, 'base64url')), `the entry for ${executorId} is signed with its own key`)
  }
  const api: TeamNamesApi = {
    teams: async (baseUrl, input) => {
      if (options.unreachable) throw new ExecutorApiError('Executor API request timed out.', { code: 'EXECUTOR_API_TIMEOUT' })
      const request = ExecutorDaemonTeamsRequestSchema.parse(input)
      calls.push({ route: 'teams', baseUrl, executorIds: request.entries.map((entry) => entry.executorId) })
      if (options.old) throw new ExecutorApiError('Route POST:/api/executor-daemon/teams not found', { status: 404 })
      for (const { signature, ...payload } of request.entries) {
        verifySigned(payload.executorId, EXECUTOR_DAEMON_TEAMS_SIGNATURE_DOMAIN, payload, signature)
      }
      return { teams: request.entries.flatMap((entry) => {
        const found = names.get(entry.executorId)
        return found ? [{ executorId: entry.executorId, ...found }] : []
      }) }
    },
    pairing: async (baseUrl, action, input) => {
      assert.equal(action, 'connection', 'names are read only through the connection read')
      const { signature, ...payload } = input as { executorId: string; timestamp: string; signature: string }
      calls.push({ route: 'connection', baseUrl, executorIds: [payload.executorId] })
      verifySigned(payload.executorId, 'nessie.executor.pairing.connection.v1', payload, signature)
      if (options.refuseConnection) {
        throw new ExecutorApiError('A current sign-in is required.', { code: 'UOA_SESSION_REQUIRED', status: 401 })
      }
      const found = names.get(payload.executorId)
      if (!found) throw new ExecutorApiError('Not found.', { status: 404 })
      return { executorId: payload.executorId, machineName: 'This computer',
        organization: { id: 'org', name: found.organizationName },
        team: found.teamName ? { id: 'team', name: found.teamName } : null,
        scope: { kind: 'private', organizationId: '00000000-0000-4000-8000-000000000003' },
        claimDigest: `sha256:${'b'.repeat(64)}` }
    },
  }
  return { api, calls }
}
