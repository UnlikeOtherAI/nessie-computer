import type { Readable } from 'node:stream'

/**
 * The daemon process's own lifetime: when it stops, and the one-at-a-time
 * tasks its loops run.
 */
export const waitForExecutorDaemonShutdown = async (
  parentLiveness?: Readable,
  updateReady?: Promise<void>,
): Promise<void> => new Promise((resolve) => {
  const stop = () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    parentLiveness?.off('close', stop)
    parentLiveness?.off('end', stop)
    parentLiveness?.off('error', stop)
    // A signal stops the daemon while its parent still holds the pipe, and a
    // resumed pipe left open keeps this process alive after its shutdown.
    parentLiveness?.destroy()
    resolve()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
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
