import type { Readable } from 'node:stream'

/**
 * The daemon process's own lifetime: when it stops, and the one-at-a-time
 * tasks its loops run.
 *
 * Ctrl+Break (SIGBREAK) is how the Windows installer asks a daemon it did not
 * start to stop before it replaces the files: the same graceful stop as a
 * signal or the parent closing its liveness pipe.
 */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const

export const waitForExecutorDaemonShutdown = async (
  parentLiveness?: Readable,
  updateReady?: Promise<void>,
): Promise<void> => new Promise((resolve) => {
  const stop = () => {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, stop)
    parentLiveness?.off('close', stop)
    parentLiveness?.off('end', stop)
    parentLiveness?.off('error', stop)
    // A signal stops the daemon while its parent still holds the pipe, and a
    // resumed pipe left open keeps this process alive after its shutdown.
    parentLiveness?.destroy()
    resolve()
  }
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, stop)
  void updateReady?.then(stop)
  if (parentLiveness) {
    parentLiveness.once('close', stop)
    parentLiveness.once('end', stop)
    parentLiveness.once('error', stop)
    parentLiveness.resume()
  }
})

export const createNonOverlappingExecutorTask = (
  task: () => Promise<void>,
): { current: () => Promise<void> | null; run: () => Promise<void> } => {
  let current: Promise<void> | null = null
  return {
    current: () => current,
    run: () => {
      if (current) return current
      const started = task().finally(() => {
        if (current === started) current = null
      })
      current = started
      return started
    },
  }
}
