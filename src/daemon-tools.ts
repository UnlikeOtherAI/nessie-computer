import { canonicalExecutorJson } from '@nessie/executor-protocol'

import { withBridgeOnRuntime, type ExecutorRuntime } from './coding-sessions-policy.js'
import { createCodingSessionsDaemon, withDaemonSupervisor, type CodingSessionsDaemon } from './coding-sessions-daemon.js'
import type { LocalCommandPolicy } from './command-policy.js'
import type { DaemonLiveState } from './daemon-live-state.js'
import { createLocalMcpReporter, type LocalMcpReporter } from './local-mcp-report.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import { createExecutorMcpSessionManager, type ExecutorMcpSessionManager } from './mcp-session-manager.js'
import type { OwnerRequestsGate } from './owner-requests-gate.js'
import { createSessionViewRelay, type SessionViewRelay } from './session-view-relay.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * The local MCP servers a team names — its local apps and the built-in
 * coding-sessions bridge among them — and what is built on them: the session
 * manager that starts them, the bridge's daemon side, the local-app report and
 * the session view relay.
 *
 * They are built from the saved launch specs, the bridge's reviewed facts and
 * the limits. When a live apply changes any of those, the toolbox builds a new
 * set and retires the old one between two commands, so no command is using it
 * and no connection, browser, guest or coding session is touched: coding
 * sessions run in their own host processes and outlive the bridge, as they
 * outlive a daemon restart. Command rules are not among the inputs — the
 * bridge stamps each call with the rules that hold at that moment.
 */
export type DaemonTools = {
  servers: readonly ExecutorLocalMcpServer[]
  mcpSessions: ExecutorMcpSessionManager
  codingBridge: CodingSessionsDaemon
  localMcp: LocalMcpReporter
  relayScreens: SessionViewRelay
}

export const daemonToolsKey = (state: ExecutorLocalState): string => canonicalExecutorJson({
  codingSessions: state.descriptor.codingSessions ?? null,
  limits: state.descriptor.limits,
  mcpServers: state.mcpServers ?? [],
})

const buildDaemonTools = (
  state: ExecutorLocalState,
  commandRules: LocalCommandPolicy,
  ownerRequestsGate: OwnerRequestsGate,
  runtime: ExecutorRuntime | undefined,
): DaemonTools => {
  const servers = withDaemonSupervisor(withBridgeOnRuntime(state.mcpServers ?? [], runtime))
  const mcpSessions = createExecutorMcpSessionManager(servers, state.descriptor.limits)
  const codingBridge = createCodingSessionsDaemon({
    executorId: state.executorId,
    commandRules,
    facts: state.descriptor.codingSessions,
    servers,
    sessions: mcpSessions,
    serverReadsRequests: ownerRequestsGate.understood,
  })
  const localMcp = createLocalMcpReporter(servers, mcpSessions, { codingSessions: codingBridge.report })
  const relayScreens = createSessionViewRelay(codingBridge, ownerRequestsGate.understood, ownerRequestsGate.holdReports)
  void localMcp.refresh().catch(() => undefined)
  return { servers, mcpSessions, codingBridge, localMcp, relayScreens }
}

export type DaemonToolbox = {
  readonly current: DaemonTools
  /**
   * Rebuilds when the saved inputs changed since the last build; called from
   * the command lane between commands. True when it rebuilt.
   */
  refresh: () => Promise<boolean>
}

export const createDaemonToolbox = (input: {
  live: DaemonLiveState
  /** Live command rules: read at each call, so a saved or once-allowed rule needs no rebuild. */
  commandRules: LocalCommandPolicy
  ownerRequestsGate: OwnerRequestsGate
  runtime?: ExecutorRuntime
  /** Settles once nothing outside the command lane uses the current set (the session view relay). */
  quiesce: () => Promise<void>
}): DaemonToolbox => {
  const build = (): DaemonTools => buildDaemonTools(input.live.current, input.commandRules, input.ownerRequestsGate,
    input.runtime)
  let key = daemonToolsKey(input.live.current)
  let tools = build()
  return {
    get current() { return tools },
    refresh: async () => {
      const next = daemonToolsKey(input.live.current)
      if (next === key) return false
      const retired = tools
      key = next
      tools = build()
      // A new bridge starts by telling its hosts nobody reads requests; it says what holds now.
      tools.codingBridge.ownerRequestsChanged()
      await input.quiesce()
      retired.localMcp.stop()
      await retired.mcpSessions.stopAll()
      return true
    },
  }
}
