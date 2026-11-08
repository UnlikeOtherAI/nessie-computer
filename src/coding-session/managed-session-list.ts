import type { ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { offeredCodingAgents, type LoadedCodingSessionsConfig } from './config.js'
import type { CodingRootSet } from './roots.js'
import { codingSessionPaths, readJsonPatiently } from './session-files.js'
import { listSessionMetas, readSessionMeta } from './session-requests.js'
import { deriveCodingStatus } from './status.js'
import type { CodingSessionState } from './types.js'
import { requireManagedSessionEvidence } from './session-authority.js'

/** Bound lists read only the canonical selected identities; an empty page reads no history. */
export const listManagedSessions = async (
  loaded: LoadedCodingSessionsConfig, roots: CodingRootSet, ownerKey: string,
  authority?: ExecutorCodingSessionAuthority,
) => {
  const metas = authority ? await Promise.all(authority.admissions.map(async row => {
    const meta = await readSessionMeta(codingSessionPaths(loaded.stateDir, row.sessionId))
    if (!meta) throw new Error('Original session evidence is unavailable')
    requireManagedSessionEvidence(authority, meta)
    return meta
  })) : (await listSessionMetas(loaded.stateDir)).filter(meta => meta.ownerKey === ownerKey)
  const sessions = []
  for (const meta of metas) {
    const paths = codingSessionPaths(loaded.stateDir, meta.sessionId)
    const state = await readJsonPatiently<CodingSessionState>(paths.state)
    const derived = await deriveCodingStatus(paths, state)
    sessions.push({ sessionId: meta.sessionId, title: meta.title, status: derived.status,
      ...(derived.reason ? { reason: derived.reason } : {}), agent: meta.agent, root: meta.rootName,
      path: meta.path, turn: state?.turn ?? 0, updatedAt: state?.updatedAt ?? meta.createdAt })
  }
  if (!authority) sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return { roots: roots.roots.map(root => ({ name: root.name, available: root.canonical !== undefined })),
    agents: offeredCodingAgents(loaded.config), sessions: authority ? sessions : sessions.slice(0, 30),
    ...(authority?.nextCursor ? { nextCursor: authority.nextCursor } : {}) }
}
