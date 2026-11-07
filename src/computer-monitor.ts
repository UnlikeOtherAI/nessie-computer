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
        if (!await enabled()) { subscriptions = []; return }
        if (!watching()) return
        const values = await probe()
        if (await enabled() && watching()) subscriptions = values
      })().catch(() => undefined).finally(() => { probing = undefined })
    }
  }
  const interval = setInterval(refresh, 3_000)
  interval.unref()
  refresh()
  return {
    current: (): ExecutorMonitorSnapshot | undefined => watching() && snapshot
      ? { ...snapshot, subscriptions } : undefined,
    watching,
    request: (request: ExecutorMonitorRequest | null): boolean => {
      const active = watching()
      requestedUntil = request ? Math.min(Date.parse(request.expiresAt), now() + EXECUTOR_MONITOR_VIEW_TTL_MS) : 0
      if (watching()) refresh()
      return !active && watching()
    },
    connected: (allowed: boolean): void => {
      connected = allowed
      if (!allowed) { subscriptions = []; requestedUntil = 0; lastProbe = 0 }
      else refresh()
    },
    stop: async (): Promise<void> => {
      stopped = true
      clearInterval(interval)
      await Promise.allSettled([sampling, probing])
    },
  }
}
