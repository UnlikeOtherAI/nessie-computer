import { acquireExecutorProcessLease } from './process-lease.js'

export type ExecutorDaemonLease = { release: () => Promise<void> }

/** One live daemon owns a pairing until its guest teardown completes. */
export const acquireExecutorDaemonLease = (stateDir: string): Promise<ExecutorDaemonLease> => (
  acquireExecutorProcessLease(stateDir, 'daemon.pid')
)
