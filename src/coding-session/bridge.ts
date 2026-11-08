import { randomUUID } from 'node:crypto'
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
import { readSessionConversation } from './session-view.js'
import { sessionUserAction } from '../session-user-action.js'
import { openFirst } from './session-report.js'
import { assertPersonalHostExecution } from '../personal-host-execution.js'
import { prepareManagedBridgeCall } from './session-authority.js'

export type { CodingBridge, CodingBridgeCallMeta } from './managed-bridge.js'

/** One public bridge, two distinct lifecycles. External sessions never enter the managed host registry. */
export const createCodingBridge = async (loaded: LoadedCodingSessionsConfig): Promise<CodingBridge> => {
  const managed = await createManagedBridge(loaded)
  const project = createExistingProjection(managed.rewriter)
  const existing = new ExistingSessions(dirname(loaded.configPath))
  let inventory: { id: string; observedAt: string; complete: boolean; sessions: Record<string, unknown>[] } | undefined
  process.stdin.once('end', () => { void existing.close() })
  return { rewriter: managed.rewriter, call: async (tool, value, meta) => {
    // Inventory/withdrawal are system operations. They never establish content or input authority.
    const system = ['session_inventory', 'session_list_all', 'session_close_all', 'existing_session_refresh'].includes(tool)
    const authority = system && meta.daemonControl ? null
      : await prepareManagedBridgeCall(dirname(loaded.configPath), loaded.stateDir, tool, value, meta)
    if (authority) {
      const kind = value && typeof value === 'object' ? (value as Record<string, unknown>).kind : undefined
      // Bound native/external continuity has no producer. Never probe it, even for existence.
      if (tool === 'session_queue' || tool === 'session_push' || tool === 'session_steer'
        || tool === 'existing_session_screen' || tool === 'session_user_action' && (kind === 'queue' || kind === 'push')) {
        throw new CodingBridgeError('coding_session_authority_unavailable', 'Original session authority is unavailable.')
      }
      if (tool !== 'session_user_action' && tool !== 'session_conversation') return managed.call(tool, value, meta)
    }
    if (tool === 'session_user_action' && meta.daemonControl) {
      const receipt = await sessionUserAction(value, dirname(loaded.configPath), managed, async (...args) => {
        await assertPersonalHostExecution()
        return existing.send(...args)
      }, meta)
      return { receipt }
    }
    if (tool === 'session_inventory') {
      if (!meta.daemonControl) throw new CodingBridgeError('coding_session_owner_required', 'Daemon control is required.')
      const args = argumentsFor(value, ['cursor'])
      const cursor = typeof args.cursor === 'string' ? /^([a-f0-9-]{36}):(\d+)$/u.exec(args.cursor) : null
      if (!cursor || !inventory || cursor[1] !== inventory.id) {
        const result = await managed.call(tool, {}, meta)
        const native = project(await existing.inventory())
        inventory = { id: randomUUID(), observedAt: new Date().toISOString(), complete: existing.inventoryIsComplete(),
          sessions: openFirst([...(result.sessions as Record<string, unknown>[]), ...native], 5000) }
      }
      const offset = cursor?.[1] === inventory.id ? Math.min(5000, Number(cursor[2])) : 0
      const sessions = inventory.sessions.slice(offset, offset + 32)
      const end = offset + sessions.length >= inventory.sessions.length
      const complete = end && inventory.complete
      return { sessions, inventory: { id: inventory.id, observedAt: inventory.observedAt, complete },
        nextCursor: end ? null : `${inventory.id}:${offset + sessions.length}` }
    }
    if (tool === 'session_list_all') {
      const result = await managed.call(tool, value, meta)
      const native = project(await existing.inventory())
      return { ...result, sessions: openFirst([...(result.sessions as Record<string, unknown>[]), ...native]) }
    }
    if (tool === 'session_conversation' && meta.daemonControl) {
      const args = argumentsFor(value, ['sessionId', 'ownerKey'])
      const id = sessionIdArgument(args.sessionId)
      if (args.ownerKey === EXISTING_CODING_SESSION_OWNER_KEY) {
        const result = project(await existing.read(id, true))
        return { conversation: result.conversation ?? null }
      }
      if (typeof args.ownerKey !== 'string') throw new CodingBridgeError('coding_session_owner_required', 'Owner is required.')
      const paths = codingSessionPaths(loaded.stateDir, id)
      const session = await readSessionMeta(paths)
      if (!session || session.ownerKey !== args.ownerKey) return { conversation: null }
      return { conversation: await readSessionConversation(paths, session) }
    }
    if (tool === 'existing_session_refresh' && meta.daemonControl) {
      argumentsFor(value, [])
      return { changed: await existing.refreshStatuses().catch(() => false) }
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
