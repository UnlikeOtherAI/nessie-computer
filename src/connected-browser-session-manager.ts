import {
  ExecutorConnectedBrowserActArgumentsSchema,
  ExecutorConnectedBrowserObserveArgumentsSchema,
  ExecutorConnectedBrowserOpenArgumentsSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import {
  connectedBrowserUrlAllowed,
  createConnectedBrowserCapability,
  type ConnectedBrowserTransport,
} from './connected-browser-protocol.js'
import type { ExecutorLocalState } from './state-store.js'

const MAX_SESSION_MS = 10 * 60 * 1_000

type ActiveSession = {
  capability: string
  nodeIds: Set<number>
  stopTimer: NodeJS.Timeout
  tabId: string
}

export type ExecutorConnectedBrowserSessionManager = {
  act: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  observe: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  open: (command: ExecutorCommandEnvelope, runId: string) => Promise<Record<string, unknown>>
  stop: (runId: string) => Promise<boolean>
  stopAll: () => Promise<void>
}

const unavailable = (): Record<string, unknown> => ({ code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false })
const denied = (): Record<string, unknown> => ({ code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false })

/**
 * A connected tab is deliberately not a guest VM or COW workspace. This
 * manager is dormant until the server-side private-run/provenance gate ships;
 * it has no fallback to the isolated browser manager.
 */
export const createExecutorConnectedBrowserSessionManager = (
  state: ExecutorLocalState,
  input: { allowedOrigins: readonly string[]; transport: ConnectedBrowserTransport },
): ExecutorConnectedBrowserSessionManager => {
  const origins = new Set(input.allowedOrigins)
  const activeByRun = new Map<string, ActiveSession>()
  const usedRunIds = new Set<string>()

  const stop = async (runId: string): Promise<boolean> => {
    const active = activeByRun.get(runId)
    if (!active) return false
    activeByRun.delete(runId)
    clearTimeout(active.stopTimer)
    await input.transport.stop({ capability: active.capability, tabId: active.tabId }).catch(() => undefined)
    return true
  }

  return {
    open: async (command, runId) => {
      if (usedRunIds.has(runId)) return { code: 'EXECUTOR_CONNECTED_BROWSER_SESSION_USED', success: false }
      const maxSessions = state.descriptor.limits.maxSessions
      if (!Number.isInteger(maxSessions) || maxSessions < 1 || activeByRun.size >= maxSessions) return unavailable()
      const args = ExecutorConnectedBrowserOpenArgumentsSchema.safeParse(command.payload.args)
      if (!args.success || !connectedBrowserUrlAllowed(args.data.url, origins)) return denied()
      usedRunIds.add(runId)
      const capability = createConnectedBrowserCapability()
      try {
        const opened = await input.transport.open({ capability, runId, url: args.data.url })
        if (!opened.tabId) return unavailable()
        const active: ActiveSession = {
          capability,
          nodeIds: new Set(),
          stopTimer: setTimeout(() => { void stop(runId) }, MAX_SESSION_MS),
          tabId: opened.tabId,
        }
        activeByRun.set(runId, active)
        return { status: 'awaiting_human_tab_approval', success: true }
      } catch {
        return unavailable()
      }
    },
    observe: async (command, runId) => {
      if (!ExecutorConnectedBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) return denied()
      const active = activeByRun.get(runId)
      if (!active) return unavailable()
      try {
        const observation = await input.transport.observe({ capability: active.capability, tabId: active.tabId })
        if (!connectedBrowserUrlAllowed(observation.url, origins)) {
          await stop(runId)
          return { code: 'EXECUTOR_CONNECTED_BROWSER_ORIGIN_CHANGED', success: false }
        }
        active.nodeIds = new Set(observation.accessibilityTree.map((node) => node.nodeId))
        return {
          accessibilityTree: observation.accessibilityTree,
          success: true,
          targets: [{ title: 'Connected Chrome tab', type: 'page', url: observation.url }],
        }
      } catch {
        await stop(runId)
        return unavailable()
      }
    },
    act: async (command, runId) => {
      const args = ExecutorConnectedBrowserActArgumentsSchema.safeParse(command.payload.args)
      const active = activeByRun.get(runId)
      if (!args.success) return denied()
      if (!active) return unavailable()
      if (args.data.action === 'navigate' && !connectedBrowserUrlAllowed(args.data.url, origins)) return denied()
      const actionNodeId = 'nodeId' in args.data ? args.data.nodeId : undefined
      if (actionNodeId !== undefined && !active.nodeIds.has(actionNodeId)) {
        return { code: 'EXECUTOR_CONNECTED_BROWSER_STALE_NODE', success: false }
      }
      try {
        const result = await input.transport.act({
          action: args.data,
          capability: active.capability,
          tabId: active.tabId,
        })
        // An action invalidates every prior target. The next action must be
        // based on a newly observed extension frame.
        active.nodeIds.clear()
        if (result.settledUrl && !connectedBrowserUrlAllowed(result.settledUrl, origins)) {
          await stop(runId)
          return { code: 'EXECUTOR_CONNECTED_BROWSER_ORIGIN_CHANGED', success: false }
        }
        return { ...(result.settledUrl ? { settledUrl: result.settledUrl } : {}), status: 'acted', success: true }
      } catch {
        await stop(runId)
        return unavailable()
      }
    },
    stop,
    stopAll: async () => { await Promise.allSettled([...activeByRun.keys()].map(stop)) },
  }
}
