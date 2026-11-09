import { EXECUTOR_MONITOR_VIEW_TTL_MS,
  type ExecutorMonitorRequest, type ExecutorMonitorSnapshot, type ExecutorSubscription } from '@nessie/executor-protocol'

import { existingSessionsEnabled } from './existing-session/settings.js'
import { readProviderSubscriptions } from './provider-subscriptions.js'
import { createSystemMonitor } from './system-monitor.js'

/** Sampling is independent of the heartbeat: a slow provider cannot make a computer appear offline. */
export const startComputerMonitor = (stateDir: string, dependencies: {
  sample?: ReturnType<typeof createSystemMonitor>
  probe?: typeof readProviderSubscriptions
  enabled?: () => Promise<boolean>
  now?: () => number
} = {}) => {
  const sample = dependencies.sample ?? createSystemMonitor()
  const probe = dependencies.probe ?? readProviderSubscriptions
  const enabled = dependencies.enabled ?? (() => existingSessionsEnabled(stateDir))
  const now = dependencies.now ?? Date.now
  let snapshot: Omit<ExecutorMonitorSnapshot, 'subscriptions'> | null = null
  let subscriptions: ExecutorSubscription[] = []
  let subscriptionsIncomplete = false
  let connected = false
  let stopped = false
  let sampling: Promise<void> | undefined
  let probing: Promise<void> | undefined
  let lastProbe = 0
  let lastSample = 0
  let requestedUntil = 0
  const watching = (): boolean => !stopped && connected && requestedUntil > now()
  const refresh = (): void => {
    if (stopped) return
    if (!sampling && (lastSample === 0 || now() - lastSample >= 3_000)) {
      lastSample = now()
      sampling = sample().then((value) => { if (!stopped) snapshot = value }, () => undefined)
        .finally(() => { sampling = undefined })
    }
    if (!probing && watching() && (lastProbe === 0 || now() - lastProbe >= 60_000)) {
      lastProbe = now()
      probing = (async () => {
        if (!await enabled()) { subscriptions = []; subscriptionsIncomplete = false; return }
        if (!watching()) return
        const readings = await probe()
        if (!await enabled()) { subscriptions = []; subscriptionsIncomplete = false; return }
        if (watching()) {
          subscriptionsIncomplete = readings.incomplete
          subscriptions = readings.accounts.map(value => {
            const previous = subscriptions.find(old => old.provider === value.provider
              && (value.sourceKey ? old.sourceKey === value.sourceKey : !old.sourceKey))
            const sameAccount = !value.account || !previous?.account
              || value.account.trim().toLowerCase() === previous.account.trim().toLowerCase()
            const sameKey = !value.accountKey || !previous?.accountKey || value.accountKey === previous.accountKey
            const sameWorkspace = !value.workspaceKey || !previous?.workspaceKey
              || value.workspaceKey === previous.workspaceKey
            return value.status === 'unavailable' && sameAccount && sameKey && sameWorkspace && previous?.windows.length
              ? { ...previous, status: value.status } : value
          })
        }
      })().catch(() => undefined).finally(() => { probing = undefined })
    }
  }
  const interval = setInterval(refresh, 3_000)
  interval.unref()
  refresh()
  return {
    current: (): ExecutorMonitorSnapshot | undefined => watching() && snapshot
      ? { ...snapshot, subscriptions: subscriptions.slice(0, 64),
        ...(subscriptionsIncomplete || subscriptions.length > 64
          ? { subscriptionsIncomplete: true } : {}) } : undefined,
    watching,
    request: (request: ExecutorMonitorRequest | null): boolean => {
      const active = watching()
      requestedUntil = request ? Math.min(Date.parse(request.expiresAt), now() + EXECUTOR_MONITOR_VIEW_TTL_MS) : 0
      if (watching()) refresh()
      return !active && watching()
    },
    connected: (allowed: boolean): void => {
      connected = allowed
      if (!allowed) {
        subscriptions = []; subscriptionsIncomplete = false; requestedUntil = 0; lastProbe = 0
      }
      else refresh()
    },
    stop: async (): Promise<void> => {
      stopped = true
      clearInterval(interval)
      await Promise.allSettled([sampling, probing])
    },
  }
}
