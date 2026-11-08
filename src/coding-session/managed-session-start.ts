import type { SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { CodingBridgeError } from './bridge-tools.js'
import { codingCommandsDir, codingSessionPaths, createJsonExclusive, ensurePrivateDir, readJson, readJsonFile } from './session-files.js'
import { claimCommand, listSessionMetas, readSessionMeta, type CommandRecord } from './session-requests.js'
import { managedSessionEvidence, type ManagedStart } from './session-authority.js'

type StartRecord = ManagedStart & { sessionId: string; ownerKey: string; tool: 'session_start' }
const uncertain = () => new CodingBridgeError('coding_session_start_outcome_unknown',
  'The original start outcome is unavailable. Reconcile the original command before starting again.')

/** This journal is retained with session history; ordinary command-record pruning never removes it. */
export const reconcileManagedStart = async (
  stateDir: string, authority: ExecutorCodingSessionAuthority,
): Promise<{ sessionId: string; replay: Record<string, unknown> } | undefined> => {
  const { commandId, executorId, originalOwnerGeneration, ownerKey } = authority
  const directory = join(stateDir, 'accepted-starts')
  const path = join(directory, `${commandId}.json`)
  const replay = async (record: StartRecord) => {
    if (record.tool !== 'session_start' || record.executorId !== executorId
      || record.originalOwnerGeneration !== originalOwnerGeneration || record.startCommandId !== commandId
      || record.ownerKey !== ownerKey) throw uncertain()
    const meta = await readSessionMeta(codingSessionPaths(stateDir, record.sessionId))
    if (!meta?.originalManagedStart || meta.ownerKey !== ownerKey
      || meta.originalManagedStart.executorId !== executorId
      || meta.originalManagedStart.originalOwnerGeneration !== originalOwnerGeneration
      || meta.originalManagedStart.startCommandId !== commandId) throw uncertain()
    const outcome = await readJson<Record<string, unknown>>(join(directory, `${commandId}.outcome.json`))
    const proof = managedSessionEvidence(meta.originalManagedStart, meta.sessionId, meta.ownerKey)
    if (!outcome || outcome.sessionId !== meta.sessionId || outcome.startCommandId !== commandId
      || outcome.evidenceDigest !== proof.evidenceDigest || outcome.phase !== 'request_and_host_created'
      || !outcome.result || typeof outcome.result !== 'object' || Array.isArray(outcome.result)) throw uncertain()
    const result = outcome.result as Record<string, unknown>
    if (result.sessionId !== meta.sessionId || result.startPhase !== 'request_and_host_created'
      || JSON.stringify(result.startEvidence) !== JSON.stringify(proof)) throw uncertain()
    // Replay the original structural outcome. Never read history or restart a host during reconciliation.
    return { sessionId: record.sessionId, replay: outcome.result as Record<string, unknown> }
  }
  const previous = await readJsonFile<StartRecord>(path)
  if (previous.found === 'unreadable') throw uncertain()
  if (previous.found === 'yes') return replay(previous.value)
  const legacy = await readJson<CommandRecord>(join(codingCommandsDir(stateDir), `${commandId}.json`))
  const matching = (await listSessionMetas(stateDir)).some(meta => meta.originalManagedStart?.startCommandId === commandId)
  if (legacy || matching) {
    throw uncertain()
  }
  return undefined
}

export const claimManagedStart = async (
  stateDir: string, authority: ExecutorCodingSessionAuthority, effect?: SessionEffectAuthority,
): Promise<{ sessionId: string; replay?: Record<string, unknown> }> => {
  const previous = await reconcileManagedStart(stateDir, authority)
  if (previous) return previous
  const { commandId, executorId, originalOwnerGeneration, ownerKey } = authority
  const directory = join(stateDir, 'accepted-starts')
  await ensurePrivateDir(directory)
  const path = join(directory, `${commandId}.json`)
  const record: StartRecord = { executorId, originalOwnerGeneration, startCommandId: commandId,
    ownerKey, sessionId: randomUUID(), tool: 'session_start' }
  if (!await createJsonExclusive(path, record, effect)) {
    const raced = await reconcileManagedStart(stateDir, authority)
    if (!raced) throw uncertain()
    return raced
  }
  const claimed = await claimCommand(stateDir, { commandId, ownerKey, tool: 'session_start',
    sessionId: record.sessionId, at: new Date().toISOString() }, effect)
  if (claimed) throw uncertain()
  return { sessionId: record.sessionId }
}

/** A durable creation-phase receipt, after the original request and actual host creation have completed. */
export const recordManagedStartOutcome = async (
  stateDir: string, authority: ExecutorCodingSessionAuthority, result: Record<string, unknown>,
): Promise<void> => {
  const proof = result.startEvidence
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw uncertain()
  const evidence = proof as Record<string, unknown>
  if (evidence.startCommandId !== authority.commandId || evidence.executorId !== authority.executorId
    || evidence.originalOwnerGeneration !== authority.originalOwnerGeneration
    || evidence.ownerKey !== authority.ownerKey) {
    throw uncertain()
  }
  const outcome = { phase: 'request_and_host_created', sessionId: evidence.sessionId,
    startCommandId: authority.commandId, evidenceDigest: evidence.evidenceDigest, result }
  const path = join(stateDir, 'accepted-starts', `${authority.commandId}.outcome.json`)
  if (!await createJsonExclusive(path, outcome)
    && JSON.stringify(await readJson<unknown>(path)) !== JSON.stringify(outcome)) throw uncertain()
}
