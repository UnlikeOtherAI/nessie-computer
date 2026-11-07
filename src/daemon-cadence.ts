import { EXECUTOR_MONITOR_UPLOAD_INTERVAL_MS, type ExecutorDaemonWakeTopic } from '@nessie/executor-protocol'

/**
 * When the daemon runs its signed exchanges.
 *
 * Without a doorbell the command poll and the session exchange each run once
 * a second, as they always have. While the doorbell is open (`ready`) both
 * fall back to the server's `pollSeconds`, because a wake frame says when
 * there is something to fetch — except the session exchange, which keeps its
 * one-second pace while its last answer named view requests or actions:
 * somebody is watching a session, or their input is on its way.
 *
 * A wake, or a change in a session on this computer, runs its exchange at
 * once. When that exchange is already running, it runs once more as soon as
 * it ends, so nothing that changed after the running one was signed waits a
 * whole interval. A tick that finds an exchange still running skips it.
 */

export type CadenceTask = { run: () => Promise<void>; current: () => Promise<void> | null }

const FAST_MS = 1_000

export type DaemonCadence = {
  /** Runs each exchange that is due; called every quarter second. */
  tick: () => void
  /** The doorbell is open. */
  ready: (pollSeconds: number) => void
  /** The doorbell is closed: one-second cadence again. */
  down: () => void
  wake: (topics: readonly ExecutorDaemonWakeTopic[]) => void
  /** A session's status or pending requests changed on this computer. */
  sessionChanged: () => void
  /** The current slow interval while the doorbell is open, for logs and tests. */
  pollMs: () => number | undefined
}

export const createDaemonCadence = (input: {
  commands: CadenceTask
  sessions: CadenceTask
  heartbeat: CadenceTask
  /** The session exchange's last answer named view requests or actions. */
  sessionsHot: () => boolean
  /** Host readings only travel while a short-lived monitor request is active. */
  monitorHot?: () => boolean
  now?: () => number
}): DaemonCadence => {
  const now = input.now ?? Date.now
  let slowMs: number | undefined
  const started = new Map<CadenceTask, number>()
  const again = new Set<CadenceTask>()

  const launch = (task: CadenceTask, rerun: boolean): void => {
    if (task.current()) {
      if (rerun) again.add(task)
      return
    }
    started.set(task, now())
    void task.run().catch(() => undefined).finally(() => {
      if (again.delete(task)) launch(task, false)
    })
  }

  const due = (task: CadenceTask, intervalMs: number): boolean => now() - (started.get(task) ?? -Infinity) >= intervalMs

  return {
    tick: () => {
      if (due(input.commands, slowMs ?? FAST_MS)) launch(input.commands, false)
      const sessionsMs = slowMs === undefined || input.sessionsHot() ? FAST_MS : slowMs
      if (due(input.sessions, sessionsMs)) launch(input.sessions, false)
      const heartbeatMs = input.monitorHot?.() ? EXECUTOR_MONITOR_UPLOAD_INTERVAL_MS : 20_000
      if (due(input.heartbeat, heartbeatMs)) launch(input.heartbeat, false)
    },
    ready: (pollSeconds) => { slowMs = pollSeconds * 1_000 },
    down: () => { slowMs = undefined },
    wake: (topics) => {
      for (const topic of topics) {
        launch(topic === 'commands' ? input.commands : topic === 'session_views' ? input.sessions : input.heartbeat, true)
      }
    },
    sessionChanged: () => launch(input.sessions, true),
    pollMs: () => slowMs,
  }
}
