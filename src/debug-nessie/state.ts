import { createHash, createPublicKey, randomInt, randomUUID, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  canonicalExecutorJson, canonicalExecutorPayload,
  type ExecutorCommandEnvelope, type ExecutorManagedSessionEvidence, type ExecutorPairingClaim,
} from '@nessie/executor-protocol'

/**
 * What the debug control plane remembers. It stands in for Nessie's database:
 * pairing codes, the computers they became, and the commands waiting for a
 * computer. Saved to one JSON file so a restarted debug server still knows its
 * computers, because a computer's connection epoch and policy revision may only
 * move forwards.
 */

export type NamedReference = { id: string; name: string }

export type DebugPairing = {
  id: string
  code: string
  machineName: string
  machinePublicKey: string
  expiresAt: string
  /** The computer the claim created, once somebody claimed the code. */
  executorId?: string
  claimDigest?: string
  rejected?: true
  /** The existing connection this attempt was folded into. */
  retainedExecutorId?: string
}

export type DebugComputer = {
  id: string
  label: string
  machinePublicKey: string
  organization: NamedReference
  team: NamedReference | null
  pairingId: string
  revoked: boolean
  connectionEpoch: number
  revision: number
  authorizationRevision: number
  originalOwnerGeneration: string
  fence: number
  descriptor?: unknown
  lastSeenAt?: string
  /** Sessions this control plane accepted a start for, as Nessie's admissions table would hold them. */
  admissions: ExecutorManagedSessionEvidence[]
}

export type QueuedCommand = {
  envelope: ExecutorCommandEnvelope
  executorId: string
  accepted: boolean
  createdAt: number
  states: string[]
  settle: (result: Record<string, unknown>) => void
}

export type DebugState = {
  pairings: DebugPairing[]
  computers: DebugComputer[]
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
export const digest = (value: string): `sha256:${string}` => `sha256:${sha256(value)}`

/** True when `signature` is the machine key's signature over this domain and payload. */
export const signedBy = (
  machinePublicKey: string, domain: string, payload: Record<string, unknown>, signature: unknown,
): boolean => {
  if (typeof signature !== 'string') return false
  try {
    const key = createPublicKey({ format: 'der', type: 'spki',
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(machinePublicKey, 'base64url')]) })
    return verify(null, Buffer.from(canonicalExecutorPayload(domain, payload)), key, Buffer.from(signature, 'base64url'))
  } catch { return false }
}

export const newCode = (taken: ReadonlySet<string>): string => {
  for (;;) {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    if (!taken.has(code)) return code
  }
}

export const claimOf = (computer: DebugComputer, claimDigest?: string): ExecutorPairingClaim => ({
  executorId: computer.id, machineName: computer.label,
  organization: computer.organization, team: computer.team,
  scope: { kind: 'private', organizationId: computer.organization.id } as ExecutorPairingClaim['scope'],
  claimDigest: (claimDigest ?? digest(canonicalExecutorJson({
    executorId: computer.id, organizationId: computer.organization.id, teamId: computer.team?.id ?? null,
  }))) as ExecutorPairingClaim['claimDigest'],
})

export const newComputer = (
  pairing: DebugPairing, organization: NamedReference, team: NamedReference | null,
): DebugComputer => ({
  id: randomUUID(), label: pairing.machineName, machinePublicKey: pairing.machinePublicKey,
  organization, team, pairingId: pairing.id, revoked: false, connectionEpoch: 0, revision: 0,
  authorizationRevision: 1, originalOwnerGeneration: randomUUID(), fence: 0, admissions: [],
})

export const loadState = async (path: string | undefined): Promise<DebugState> => {
  if (!path) return { pairings: [], computers: [] }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<DebugState>
    return { pairings: parsed.pairings ?? [], computers: parsed.computers ?? [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pairings: [], computers: [] }
    throw error
  }
}

let saving: Promise<void> = Promise.resolve()

/** One write at a time, each from a draft of its own: requests finish together and must not share a draft. */
export const saveState = (path: string | undefined, state: DebugState): Promise<void> => {
  if (!path) return Promise.resolve()
  const text = `${JSON.stringify(state, null, 2)}\n`
  saving = saving.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const draft = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(draft, text, { mode: 0o600 })
    await rename(draft, path)
  })
  return saving
}
