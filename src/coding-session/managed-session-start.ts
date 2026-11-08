import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { CodingBridgeError } from './bridge-tools.js'
import { codingCommandsDir, codingSessionPaths, createJsonExclusive, ensurePrivateDir, readJson } from './session-files.js'
import { claimCommand, listSessionMetas, readSessionMeta, type CommandRecord } from './session-requests.js'
import { managedSessionEvidence, type ManagedStart } from './session-authority.js'

type StartRecord = ManagedStart & { sessionId: string; ownerKey: string; tool: 'session_start' }
const uncertain = () => new CodingBridgeError('coding_session_start_outcome_unknown',
  'The original start outcome is unavailable. Reconcile the original command before starting again.')

/** This journal is retained with session history; ordinary command-record pruning never removes it. */
export const claimManagedStart = async (
  stateDir: string, authority: ExecutorCodingSessionAuthority,
): Promise<{ sessionId: string; replay?: Record<string, unknown> }> => {
  const { commandId, executorId, originalOwnerGeneration, ownerKey } = authority
  const directory = join(stateDir, 'accepted-starts')
  await ensurePrivateDir(directory)
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
    // Replay the original structural outcome. Never read history or restart a host during reconciliation.
    return { sessionId: record.sessionId, replay: { sessionId: record.sessionId, status: 'starting',
      agent: meta.agent, title: meta.title, replayed: true,
      startEvidence: managedSessionEvidence(meta.originalManagedStart, meta.sessionId, meta.ownerKey) } }
  }
  const previous = await readJson<StartRecord>(path)
  if (previous) return replay(previous)
  const legacy = await readJson<CommandRecord>(join(codingCommandsDir(stateDir), `${commandId}.json`))
  if (legacy || (await listSessionMetas(stateDir)).some(meta => meta.originalManagedStart?.startCommandId === commandId)) {
    throw uncertain()
  }
  const record: StartRecord = { executorId, originalOwnerGeneration, startCommandId: commandId,
    ownerKey, sessionId: randomUUID(), tool: 'session_start' }
  if (!await createJsonExclusive(path, record)) {
    const raced = await readJson<StartRecord>(path)
    if (!raced) throw uncertain()
    return replay(raced)
  }
  const claimed = await claimCommand(stateDir, { commandId, ownerKey, tool: 'session_start',
    sessionId: record.sessionId, at: new Date().toISOString() })
  if (claimed) throw uncertain()
  return { sessionId: record.sessionId }
}
