import {
  canonicalExecutorJson,
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  EXECUTOR_MCP_SERVER_MAXIMUM,
} from '@nessie/executor-protocol'

import { discoverLocalApps, type DiscoveredLocalApp, type LocalAppDiscoveryOptions } from './local-app-discovery.js'
import type { LocalAppStartState } from './local-app-start-status.js'
import { localMcpPolicyOf, MCP_OPERATION_KEYS, type LocalMcpPolicy } from './mcp-policy.js'
import { executorLocalMcpServerNames, type ExecutorLocalMcpServer, type LocalAppSource } from './mcp-servers.js'
import { saveExecutorState, type ExecutorLocalState } from './state-store.js'

/**
 * The local apps a revision fronts, from the owner's named servers, the
 * discovered ones and the local-apps policy. `state.mcpServers` always holds
 * exactly this set — owner-named entries without a `source`, discovered ones
 * with theirs — so the descriptor's names, the MCP sessions and the report
 * keep reading one list, as they did before discovery existed.
 */

const isBridge = (server: ExecutorLocalMcpServer): boolean => server.name === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME

/**
 * Owner-named servers first, then — under `installed` — every installed
 * discovered app the owner has not switched off and no owner entry already
 * names, in discovery order, up to the descriptor's limit; the coding-sessions
 * bridge stays last. Under `listed` the discovered ones are dropped.
 */
export const composeLocalMcpServers = (
  named: readonly ExecutorLocalMcpServer[],
  discovered: readonly DiscoveredLocalApp[],
  policy: LocalMcpPolicy,
): ExecutorLocalMcpServer[] => {
  const owner = named.filter((server) => server.source === undefined)
  if (policy.mode === 'listed') return [...owner]
  const taken = new Set(owner.map((server) => server.name))
  const room = Math.max(0, EXECUTOR_MCP_SERVER_MAXIMUM - owner.length)
  const added = discovered
    .filter((app) => app.installed && !taken.has(app.server.name) && !policy.disabled.includes(app.server.name))
    .slice(0, room)
    .map((app) => ({ ...app.server }))
  return [...owner.filter((server) => !isBridge(server)), ...added, ...owner.filter(isBridge)]
}

/** The state's own discovered entries, for when no fresh discovery has been made. */
const storedLocalApps = (state: ExecutorLocalState): DiscoveredLocalApp[] => (state.mcpServers ?? [])
  .filter((server): server is DiscoveredLocalApp['server'] => server.source !== undefined)
  .map((server) => ({ installed: true, server }))

/**
 * The operations a revision names, given how many local apps it fronts. Under
 * `listed` the owner's choice stands. Under `installed` local apps are on by
 * default, so the MCP pair is present exactly while there is a server to
 * reach — never at the cost of the descriptor's last operation.
 */
export const managedMcpOperations = (
  operationKeys: readonly string[], policy: LocalMcpPolicy, serverCount: number,
): string[] => {
  if (policy.mode === 'listed') return [...operationKeys]
  const others = operationKeys.filter((key) => !(MCP_OPERATION_KEYS as readonly string[]).includes(key))
  if (serverCount > 0) return [...others, ...MCP_OPERATION_KEYS]
  return others.length > 0 ? others : [...operationKeys]
}

/**
 * `state` with its local apps recomputed: the server list, the descriptor's
 * names and the MCP operation pair ({@link managedMcpOperations}). The
 * revision is untouched; a caller that is not already writing a new one uses
 * {@link localAppsRevision}.
 */
export const withLocalApps = (
  state: ExecutorLocalState,
  discovered: readonly DiscoveredLocalApp[],
  policy: LocalMcpPolicy = localMcpPolicyOf(state),
): ExecutorLocalState => {
  const servers = composeLocalMcpServers(state.mcpServers ?? [], discovered, policy)
  const operationKeys = managedMcpOperations(state.descriptor.operationKeys, policy, servers.length)
  const descriptor = { ...state.descriptor, operationKeys }
  delete descriptor.mcpServers
  const next: ExecutorLocalState = {
    ...state,
    descriptor: { ...descriptor, ...(servers.length ? { mcpServers: executorLocalMcpServerNames(servers) } : {}) },
    ...(servers.length ? { mcpServers: servers } : {}),
  }
  if (!servers.length) delete next.mcpServers
  return next
}

const localAppsFacts = (state: ExecutorLocalState): string => canonicalExecutorJson({
  descriptorNames: state.descriptor.mcpServers ?? [],
  operations: state.descriptor.operationKeys,
  servers: state.mcpServers ?? [],
})

/**
 * The next revision when the local apps this computer should front differ from
 * what the current one fronts — a server installed, removed, moved or switched
 * off — and `undefined` when they do not. A2's daemon calls this (through
 * {@link refreshLocalApps}) on its own cadence and live-applies the result.
 */
export const localAppsRevision = (
  state: ExecutorLocalState, discovered: readonly DiscoveredLocalApp[],
): ExecutorLocalState | undefined => {
  const next = withLocalApps(state, discovered)
  if (localAppsFacts(next) === localAppsFacts(state)) return undefined
  return { ...next, descriptor: { ...next.descriptor, revision: state.descriptor.revision + 1 } }
}

/**
 * Discover, and save a new revision through the compare-and-set writer when
 * the local apps changed. Answers the saved state, or `undefined` when
 * nothing changed. A state changed by somebody else since `state` was read is
 * refused by the writer, exactly as a concurrent `configure` would be.
 */
export const refreshLocalApps = async (
  stateDir: string, state: ExecutorLocalState, options: LocalAppDiscoveryOptions = {},
): Promise<ExecutorLocalState | undefined> => {
  const next = localAppsRevision(state, await discoverLocalApps(options))
  if (!next) return undefined
  await saveExecutorState(stateDir, next, state)
  return next
}

/** One local app as `describe` reports it (contract §4.5). */
export type LocalAppDescription = {
  name: string
  /** Where it was found; `configured` when the owner named it. */
  source: LocalAppSource | 'configured'
  /** Whether this computer lets the team use it now. */
  enabled: boolean
  /**
   * Whether its program is on this computer. An owner-named app reads `true`:
   * the owner's entry is the claim, and the MCP report says whether it starts.
   */
  installed: boolean
  /** Why a discovered app is not enabled. */
  reason?: 'switched_off' | 'not_installed' | 'limit' | 'listed_only'
  /**
   * An enabled app whose last starts failed, as the running daemon saw them
   * (`local-app-start-status.ts`): how many in a row, why, and when it is
   * tried again. Absent while it starts.
   */
  start?: LocalAppStartState
}

/** Each enabled app with its start state, when its last starts failed. */
export const withLocalAppStartStates = (
  apps: readonly LocalAppDescription[], starts: ReadonlyMap<string, LocalAppStartState>,
): LocalAppDescription[] => apps.map((app) => {
  const start = app.enabled ? starts.get(app.name) : undefined
  return start ? { ...app, start } : app
})

/**
 * Every local app this computer knows of for the team: the owner-named ones,
 * then each discovered one (a name the owner also named is the owner's). With
 * no fresh `discovered`, the discovered entries the state already fronts stand
 * in. The executor's own coding-sessions bridge is not a local app; it lives
 * under Coding assistants.
 */
export const describeLocalApps = (
  state: ExecutorLocalState, discovered: readonly DiscoveredLocalApp[] = storedLocalApps(state),
): LocalAppDescription[] => {
  const policy = localMcpPolicyOf(state)
  const owner = (state.mcpServers ?? []).filter((server) => server.source === undefined && !isBridge(server))
  const fronted = new Set(composeLocalMcpServers(state.mcpServers ?? [], discovered, policy)
    .map((server) => server.name))
  const named = new Set(owner.map((server) => server.name))
  const reason = (app: DiscoveredLocalApp): LocalAppDescription['reason'] => {
    if (policy.mode === 'listed') return 'listed_only'
    if (policy.disabled.includes(app.server.name)) return 'switched_off'
    return app.installed ? 'limit' : 'not_installed'
  }
  return [
    ...owner.map((server): LocalAppDescription => ({
      name: server.name, source: 'configured', enabled: true, installed: true,
    })),
    ...discovered.filter((app) => !named.has(app.server.name)).map((app): LocalAppDescription => {
      const enabled = fronted.has(app.server.name)
      return {
        name: app.server.name, source: app.server.source, enabled, installed: app.installed,
        ...(enabled ? {} : { reason: reason(app) }),
      }
    }),
  ]
}
