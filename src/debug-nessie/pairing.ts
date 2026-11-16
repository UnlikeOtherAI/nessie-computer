import { createHash } from 'node:crypto'

import {
  canonicalExecutorJson,
  ExecutorPairingConnectionRequestSchema, ExecutorPairingPollRequestSchema, ExecutorPairingReuseRequestSchema,
  ExecutorPairingStartRequestSchema, type ExecutorPairingPollResponse,
} from '@nessie/executor-protocol'

import {
  claimOf, digest, newCode, newComputer, signedBy,
  type DebugComputer, type DebugPairing, type DebugState, type NamedReference,
} from './state.js'

/**
 * Nessie's code pairing, as the computer sees it: the same routes, proofs,
 * refusals and status words (`docs/windows-admission-recovery.md`, and
 * Nessie's `docs/executor-protocol/code-pairing.md`). The person's side, which
 * in Nessie is the Add a computer dialog, is `claim` below.
 */

export type Reply = { status: number; data?: unknown; error?: { code: string; message: string } }

const ok = (data: unknown): Reply => ({ status: 200, data })
const refuse = (status: number, code: string, message: string): Reply => ({ status, error: { code, message } })
const unavailable = (): Reply => refuse(400, 'ENROLLMENT_USED', 'This pairing is no longer available.')
const badProof = (message = 'Machine proof is invalid.'): Reply => refuse(400, 'ENROLLMENT_PROOF_INVALID', message)
const fresh = (timestamp: string, now: number): boolean => Math.abs(now - Date.parse(timestamp)) <= 60_000
const domain = (action: string): string => `nessie.executor.pairing.${action}.v1`

/** A stable id for a name, so the same team name is the same team every time. */
export const referenceFor = (kind: 'organization' | 'team', name: string): NamedReference => {
  const hex = createHash('sha256').update(`${kind}:${name}`).digest('hex')
  const id = [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`,
    hex.slice(20, 32)]
  return { id: id.join('-'), name }
}

const active = (computer: DebugComputer | undefined): computer is DebugComputer => (
  Boolean(computer && !computer.revoked)
)

/** Revokes a computer; one no daemon was ever heard from leaves no row behind. */
export const revoke = (state: DebugState, computer: DebugComputer): void => {
  computer.revoked = true
  computer.authorizationRevision += 1
  computer.connectionEpoch += 1
  if (!computer.lastSeenAt) state.computers = state.computers.filter((entry) => entry.id !== computer.id)
}

const outcome = (state: DebugState, pairing: DebugPairing, now: number): ExecutorPairingPollResponse => {
  const base = { pairingId: pairing.id, fingerprint: digest(pairing.machinePublicKey), expiresAt: pairing.expiresAt }
  const retained = state.computers.find((entry) => entry.id === pairing.retainedExecutorId)
  if (active(retained)) {
    return { ...base, status: 'reused', reusedConnection: claimOf(retained) } as ExecutorPairingPollResponse
  }
  const computer = state.computers.find((entry) => entry.id === pairing.executorId)
  if (pairing.rejected || pairing.executorId && !active(computer)) {
    return { ...base, status: 'rejected' } as ExecutorPairingPollResponse
  }
  if (computer) {
    return { ...base, status: 'confirmed', claim: claimOf(computer, pairing.claimDigest) } as ExecutorPairingPollResponse
  }
  return { ...base, status: Date.parse(pairing.expiresAt) <= now ? 'expired' : 'waiting' } as ExecutorPairingPollResponse
}

export const handlePairing = (
  state: DebugState, action: string, body: Record<string, unknown>, now = Date.now(),
): Reply => {
  if (action === 'start') {
    const parsed = ExecutorPairingStartRequestSchema.safeParse(body)
    if (!parsed.success) return refuse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.')
    const { signature, replacementSignature, ...payload } = parsed.data
    if (!fresh(payload.timestamp, now)) return badProof('Machine request has expired.')
    if (!signedBy(payload.machinePublicKey, domain('start'), payload, signature)) return badProof()
    let pairing = state.pairings.find((entry) => entry.id === payload.requestId)
    if (pairing && (pairing.rejected || pairing.machinePublicKey !== payload.machinePublicKey)) return unavailable()
    if (payload.replacesExecutorId) {
      const previous = state.computers.find((entry) => entry.id === payload.replacesExecutorId)
      if (!previous || !signedBy(previous.machinePublicKey, domain('replace'), payload, replacementSignature)) {
        return badProof()
      }
      if (!previous.revoked) revoke(state, previous)
    }
    if (!pairing) {
      pairing = { id: payload.requestId, code: newCode(new Set(state.pairings.map((entry) => entry.code))),
        machineName: payload.machineName, machinePublicKey: payload.machinePublicKey,
        expiresAt: new Date(now + 600_000).toISOString() }
      state.pairings.push(pairing)
    }
    return ok({ pairingId: pairing.id, code: pairing.code, fingerprint: digest(pairing.machinePublicKey),
      expiresAt: pairing.expiresAt, pollIntervalSeconds: 3 })
  }

  if (action === 'connection' || action === 'sign-off') {
    const parsed = ExecutorPairingConnectionRequestSchema.safeParse(body)
    if (!parsed.success) return refuse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.')
    const { signature, ...payload } = parsed.data
    if (!fresh(payload.timestamp, now)) return badProof('Machine request has expired.')
    const computer = state.computers.find((entry) => entry.id === payload.executorId)
    if (!computer) return unavailable()
    if (!signedBy(computer.machinePublicKey, domain(action), payload, signature)) return badProof()
    if (action === 'sign-off') {
      if (!computer.revoked) revoke(state, computer)
      return ok({ signedOff: true })
    }
    // Only this connection's own key learns that it is definitively inactive.
    return computer.revoked
      ? refuse(410, 'EXECUTOR_PAIRING_CONNECTION_INACTIVE', 'This computer connection is inactive.')
      : ok(claimOf(computer))
  }

  if (action === 'reuse') {
    const parsed = ExecutorPairingReuseRequestSchema.safeParse(body)
    if (!parsed.success) return refuse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.')
    const { signature, retainedSignature, ...payload } = parsed.data
    if (!fresh(payload.timestamp, now)) return badProof('Machine request has expired.')
    const pairing = state.pairings.find((entry) => entry.id === payload.pairingId)
    const redundant = state.computers.find((entry) => entry.id === pairing?.executorId)
    const retained = state.computers.find((entry) => entry.id === payload.retainedExecutorId)
    const already = pairing?.retainedExecutorId === payload.retainedExecutorId
    if (!pairing || !active(retained) || pairing.executorId !== payload.executorId
      || payload.claimDigest !== pairing.claimDigest || retained.id === pairing.executorId
      || !already && (!active(redundant) || pairing.rejected
        || redundant.organization.id !== retained.organization.id
        || (redundant.team?.id ?? null) !== (retained.team?.id ?? null))) return unavailable()
    if (!signedBy(pairing.machinePublicKey, domain('reuse'), payload, signature)
      || !signedBy(retained.machinePublicKey, domain('reuse'), payload, retainedSignature)) return badProof()
    if (!already && redundant) {
      revoke(state, redundant)
      pairing.rejected = true
      pairing.retainedExecutorId = retained.id
    }
    return ok(outcome(state, pairing, now))
  }

  if (!['poll', 'cancel', 'confirm', 'reject'].includes(action)) return refuse(404, 'NOT_FOUND', 'Not found')
  const parsed = ExecutorPairingPollRequestSchema.passthrough().safeParse(body)
  if (!parsed.success) return refuse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.')
  const { signature, ...payload } = parsed.data
  if (!fresh(payload.timestamp, now)) return badProof('Machine request has expired.')
  let pairing = state.pairings.find((entry) => entry.id === payload.pairingId)
  const machinePublicKey = pairing?.machinePublicKey ?? (action === 'cancel' ? payload.machinePublicKey : undefined)
  if (!machinePublicKey || payload.machinePublicKey && payload.machinePublicKey !== machinePublicKey) {
    return unavailable()
  }
  if (!signedBy(machinePublicKey, domain(action), payload, signature)) return badProof()
  if (action === 'cancel' || action === 'reject') {
    if (!pairing) {
      // A cancellation that overtook its own lost mint: a tombstone a late mint cannot reopen.
      pairing = { id: payload.pairingId, code: `cancelled:${payload.pairingId}`, machineName: '', machinePublicKey,
        expiresAt: new Date(now).toISOString(), rejected: true }
      state.pairings.push(pairing)
    }
    const computer = state.computers.find((entry) => entry.id === pairing!.executorId)
    if (active(computer) && !pairing.retainedExecutorId) revoke(state, computer)
    pairing.rejected = true
    return ok({ pairingId: pairing.id, fingerprint: digest(machinePublicKey), expiresAt: pairing.expiresAt,
      status: 'rejected' })
  }
  if (!pairing) return unavailable()
  return ok(outcome(state, pairing, now))
}

/** What a person does in Nessie's Add a computer dialog: enter the code, in a team. */
export const claim = (
  state: DebugState, code: string, organization: NamedReference, team: NamedReference | null, now = Date.now(),
): { pairing: DebugPairing; computer: DebugComputer } => {
  const pairing = state.pairings.find((entry) => entry.code === code.replace(/\D/gu, ''))
  if (!pairing || pairing.rejected || pairing.executorId || Date.parse(pairing.expiresAt) <= now) {
    throw new Error('That code did not work: it is unknown, used, cancelled or has run out.')
  }
  const computer = newComputer(pairing, organization, team)
  state.computers.push(computer)
  pairing.executorId = computer.id
  pairing.claimDigest = digest(canonicalExecutorJson({ pairingId: pairing.id, executorId: computer.id,
    teamId: team?.id ?? null }))
  return { pairing, computer }
}
