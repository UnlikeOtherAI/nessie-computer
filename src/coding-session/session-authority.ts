import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ExecutorCodingSessionAuthoritySchema, ExecutorManagedSessionEvidenceSchema, ExecutorSessionPairingSourceSchema,
  executorManagedSessionEvidenceInput, type ExecutorCodingSessionAuthority,
  type ExecutorManagedSessionEvidence, type ExecutorSessionPairingSource,
} from '@nessie/executor-protocol'
import { CodingBridgeError } from './bridge-tools.js'
import { createJsonExclusive, ensurePrivateDir, readJson } from './session-files.js'
import { codingSessionPaths } from './session-files.js'
import { readSessionMeta } from './session-requests.js'
import type { CodingBridgeCallMeta } from './managed-bridge.js'

export type ManagedStart = Pick<ExecutorManagedSessionEvidence,
  'executorId' | 'originalOwnerGeneration' | 'startCommandId'>

export const managedSessionEvidence = (start: ManagedStart, sessionId: string, ownerKey: string) => {
  const evidence = { kind: 'managed_start' as const, ...start, sessionId, ownerKey }
  return { ...evidence, evidenceDigest: createHash('sha256')
    .update(executorManagedSessionEvidenceInput(evidence)).digest('hex') }
}

const unavailable = () => new CodingBridgeError('coding_session_authority_unavailable',
  'Original session authority is unavailable.')
const sourcePath = (directory: string, executorId: string) =>
  join(directory, 'session-pairing-sources', `${executorId}.json`)

/** Only the actual authenticated claim consumer writes this immutable local enrollment reference. */
export const acceptSessionPairingSource = async (
  directory: string, source: ExecutorSessionPairingSource,
): Promise<void> => {
  const accepted = ExecutorSessionPairingSourceSchema.parse(source)
  await ensurePrivateDir(join(directory, 'session-pairing-sources'))
  const path = sourcePath(directory, accepted.executorId)
  if (await createJsonExclusive(path, accepted)) return
  const previous = await readJson<unknown>(path)
  if (JSON.stringify(previous) !== JSON.stringify(accepted)) throw unavailable()
}

/** A mode supplied beside a command cannot establish a local compatibility branch. */
export const readSessionPairingSource = async (
  directory: string, expected: unknown,
): Promise<ExecutorSessionPairingSource> => {
  const parsed = ExecutorSessionPairingSourceSchema.safeParse(expected)
  if (!parsed.success) throw unavailable()
  const stored = ExecutorSessionPairingSourceSchema.safeParse(await readJson<unknown>(
    sourcePath(directory, parsed.data.executorId)))
  if (!stored.success || JSON.stringify(stored.data) !== JSON.stringify(parsed.data)) throw unavailable()
  return stored.data
}

/** Wire references are useful only with a live exact operation and independently persisted start evidence. */
export const readManagedSessionAuthority = (
  value: unknown, operation: string, commandId: string | undefined,
  source: ExecutorSessionPairingSource, expectedOwnerKey: string | undefined,
): ExecutorCodingSessionAuthority => {
  const parsed = ExecutorCodingSessionAuthoritySchema.safeParse(value)
  if (!parsed.success || source.kind !== 'bound' || parsed.data.executorId !== source.executorId
    || parsed.data.originalOwnerGeneration !== source.originalOwnerGeneration
    || parsed.data.commandId !== commandId || parsed.data.operation !== operation
    || parsed.data.ownerKey !== expectedOwnerKey || Date.parse(parsed.data.expiresAt) <= Date.now()
    || Date.parse(parsed.data.issuedAt) > Date.now() + 2_000) throw unavailable()
  return parsed.data
}

export const requireManagedSessionEvidence = (
  authority: ExecutorCodingSessionAuthority, session: { sessionId: string; ownerKey: string; originalManagedStart?: ManagedStart },
): ExecutorManagedSessionEvidence => {
  if (Date.parse(authority.expiresAt) <= Date.now()) throw unavailable()
  const selected = authority.admissions.find(row => row.sessionId === session.sessionId)
  if (!selected || !session.originalManagedStart) throw unavailable()
  const actual = managedSessionEvidence(session.originalManagedStart, session.sessionId, session.ownerKey)
  const parsed = ExecutorManagedSessionEvidenceSchema.parse(selected)
  if (executorManagedSessionEvidenceInput(parsed) !== executorManagedSessionEvidenceInput(actual)
    || parsed.evidenceDigest !== actual.evidenceDigest) throw unavailable()
  return actual
}

const originalEffects = new WeakMap<CodingBridgeCallMeta, ExecutorCodingSessionAuthority>()
export const originalManagedEffectScope = (meta: CodingBridgeCallMeta) => originalEffects.get(meta)

const prepared = new WeakMap<CodingBridgeCallMeta, ExecutorCodingSessionAuthority>()
export const preparedManagedSessionAuthority = (meta: CodingBridgeCallMeta) => {
  const scope = prepared.get(meta)
  if (scope && Date.parse(scope.expiresAt) <= Date.now()) throw unavailable()
  return scope
}

/** The viewer-action adapter narrows an already validated action to its one actual managed operation. */
export const managedActionOperationMeta = (
  meta: CodingBridgeCallMeta, operation: 'session_send' | 'session_interrupt' | 'session_answer', sessionId: string,
): CodingBridgeCallMeta => {
  const authority = prepared.get(meta)
  if (!authority) return meta
  if (authority.operation !== 'session_user_action' || authority.purpose !== 'control'
    || authority.admissions.length !== 1 || authority.admissions[0]?.sessionId !== sessionId) throw unavailable()
  const innerAuthority = { ...authority, operation }
  const inner = { ...meta, codingSessionAuthority: innerAuthority }
  prepared.set(inner, innerAuthority)
  originalEffects.set(inner, originalEffects.get(meta) ?? authority)
  return inner
}

/** Before any existing/native read, bridge output, image sidecar or managed action. */
export const prepareManagedBridgeCall = async (
  directory: string, stateDir: string, tool: string, args: unknown, meta: CodingBridgeCallMeta,
): Promise<ExecutorCodingSessionAuthority | null> => {
  const source = await readSessionPairingSource(directory, meta.sessionPairingSource)
  if (source.kind === 'unbound_local') return null
  const operation = tool === 'session_conversation' ? 'session_view' : tool
  const authority = readManagedSessionAuthority(meta.codingSessionAuthority, operation, meta.commandId, source, meta.ownerKey)
  if (authority.connectionEpoch !== meta.connectionEpoch) throw unavailable()
  if (tool === 'session_list') {
    const input = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    if (authority.filter.provider !== input.provider || authority.filter.search !== input.search) throw unavailable()
  }
  if (tool !== 'session_start' && tool !== 'session_list') {
    const id = args && typeof args === 'object' ? (args as Record<string, unknown>).sessionId : undefined
    if (typeof id !== 'string' || authority.admissions[0]?.sessionId !== id) throw unavailable()
  }
  for (const row of authority.admissions) {
    const session = await readSessionMeta(codingSessionPaths(stateDir, row.sessionId))
    if (!session) throw unavailable()
    requireManagedSessionEvidence(authority, session)
  }
  prepared.set(meta, authority)
  originalEffects.set(meta, authority)
  return authority
}
