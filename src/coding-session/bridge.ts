import { dirname } from 'node:path'

import { EXISTING_CODING_SESSION_OWNER_KEY } from '@nessie/executor-protocol'

import { ExistingSessions } from '../existing-session/manager.js'
import { existingSessionOverview } from '../existing-session/overview.js'
import { createExistingProjection } from '../existing-session/projection.js'
import { argumentsFor, CodingBridgeError, requiredText, sessionIdArgument } from './bridge-tools.js'
import { codingSessionPaths } from './session-files.js'
import { readSessionMeta } from './session-requests.js'
import type { LoadedCodingSessionsConfig } from './config.js'
import { createCodingBridge as createManagedBridge, type CodingBridge } from './managed-bridge.js'
import { openFirst } from './session-report.js'
import { assertPersonalHostExecution } from '../personal-host-execution.js'

export type { CodingBridge, CodingBridgeCallMeta } from './managed-bridge.js'

/** One public bridge, two distinct lifecycles. External sessions never enter the managed host registry. */
export const createCodingBridge = async (loaded: LoadedCodingSessionsConfig): Promise<CodingBridge> => {
  const managed = await createManagedBridge(loaded)
  const project = createExistingProjection(managed.rewriter)
  const existing = new ExistingSessions(dirname(loaded.configPath))
  process.stdin.once('end', () => { void existing.close() })
  return { rewriter: managed.rewriter, call: async (tool, value, meta) => {
    if (['session_list_all', 'session_inventory'].includes(tool)) {
      const result = await managed.call(tool, value, meta)
      const native = project(await existing.inventory())
      return { ...result, sessions: openFirst([...(result.sessions as Record<string, unknown>[]), ...native]) }
    }
    if (tool === 'existing_session_screen' && meta.daemonControl) {
      const args = argumentsFor(value, ['sessionId', 'ownerKey'])
      if (args.ownerKey !== EXISTING_CODING_SESSION_OWNER_KEY) return { screen: null }
      const session = await existing.read(sessionIdArgument(args.sessionId))
      const text = project(existingSessionOverview(session))
      return { screen: { ansi: text.replace(/\n/gu, '\r\n'), cols: 100, rows: 35,
        capturedAt: new Date().toISOString(), kind: 'activity' } }
    }
    if (!meta.ownerKey || !/^[A-Za-z0-9:_-]{8,128}$/u.test(meta.ownerKey)) {
      return managed.call(tool, value, meta)
    }
    if (tool === 'session_list') {
      const args = argumentsFor(value, ['provider', 'cursor', 'search'])
      if (args.provider !== undefined && args.provider !== 'codex' && args.provider !== 'claude') {
        throw new CodingBridgeError('coding_session_invalid_arguments', 'provider must be codex or claude.')
      }
      const cursor = args.cursor === undefined ? undefined : requiredText(args.cursor, 'cursor', 1_024)
      if (cursor && args.provider !== 'codex') {
        throw new CodingBridgeError('coding_session_invalid_arguments', 'A cursor requires provider=codex.')
      }
      const result = await managed.call(tool, {}, meta)
      const search = args.search === undefined ? undefined : requiredText(args.search, 'search', 200)
      const page = project(await existing.page(args.provider, cursor, search))
      const sessions = (page.sessions as Record<string, unknown>[]).map((session) => (
        { ...session, origin: 'external', agent: session.provider }
      ))
      return { ...result, ...page, sessions: [...sessions, ...(cursor ? [] : result.sessions as unknown[])] }
    }
    if (tool === 'session_queue' || tool === 'session_push' || tool === 'session_steer') {
      await assertPersonalHostExecution(meta.personalAuthority)
      const args = argumentsFor(value, ['sessionId', 'message', 'expectedTurnId'])
      if (!meta.commandId) throw new CodingBridgeError('coding_session_command_missing', 'Nessie must supply a command ID.')
      return project(await existing.send(tool.slice(8), sessionIdArgument(args.sessionId),
        requiredText(args.message, 'message', 32_000), meta.ownerKey, meta.commandId))
    }
    const args = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (typeof args.sessionId === 'string'
      && !await readSessionMeta(codingSessionPaths(loaded.stateDir, sessionIdArgument(args.sessionId)))
      && await existing.find(args.sessionId)) {
      if (tool === 'session_status') {
        argumentsFor(value, ['sessionId', 'detail', 'cursor'])
        return project(await existing.read(args.sessionId, args.detail === 'events'))
      }
      throw new CodingBridgeError('coding_session_action_unavailable',
        'This session belongs to its original client. Use its advertised Queue or Push capability; managed-session actions are unavailable.')
    }
    return managed.call(tool, value, meta)
  } }
}
