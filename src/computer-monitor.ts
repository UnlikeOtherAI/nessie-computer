import type { ExecutorMonitorSnapshot, ExecutorSubscription } from '@nessie/executor-protocol'

import { existingSessionsEnabled } from './existing-session/settings.js'
import { readProviderSubscriptions } from './provider-subscriptions.js'
import { createSystemMonitor } from './system-monitor.js'

/** Sampling is independent of the heartbeat: a slow provider cannot make a computer appear offline. */
export const startComputerMonitor = (stateDir: string) => {
  const sample = createSystemMonitor()
  let snapshot: Omit<ExecutorMonitorSnapshot, 'subscriptions'> | null = null
  let subscriptions: ExecutorSubscription[] = []
  let connected = false
  let stopped = false
  let sampling: Promise<void> | undefined
  let probing: Promise<void> | undefined
  let lastProbe = 0
  const refresh = (): void => {
    if (stopped) return
    if (!sampling) {
      sampling = sample().then((value) => { if (!stopped) snapshot = value }, () => undefined)
        .finally(() => { sampling = undefined })
    }
    if (!probing && connected && Date.now() - lastProbe >= 60_000) {
      lastProbe = Date.now()
      probing = (async () => {
        if (!await existingSessionsEnabled(stateDir)) { subscriptions = []; return }
        const values = await readProviderSubscriptions()
        if (!stopped && connected && await existingSessionsEnabled(stateDir)) subscriptions = values
      })().catch(() => undefined).finally(() => { probing = undefined })
    }
  }
  const interval = setInterval(refresh, 3_000)
  interval.unref()
  refresh()
  return {
    current: (): ExecutorMonitorSnapshot | undefined => snapshot
      ? { ...snapshot, subscriptions: connected ? subscriptions : [] } : undefined,
    connected: (allowed: boolean): void => {
      connected = allowed
      if (!allowed) subscriptions = []
      else refresh()
    },
    stop: async (): Promise<void> => {
      stopped = true
      clearInterval(interval)
      await Promise.allSettled([sampling, probing])
    },
  }
}
