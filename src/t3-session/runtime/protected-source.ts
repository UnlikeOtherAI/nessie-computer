import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { T3ProtectedGraphStartup } from '@nessie/executor-protocol/t3-session'
import { ensureOwnerOnlyStateDirectory } from '../../state-security.js'
import { withT3ExecutionResources } from '../source/execution.js'
import { withSessionExecutionState } from './execution-state.js'
import { withHeldSessionInspectionRuntime, type HeldSessionInspectionRuntime } from './inspection-runtime.js'

/** Fixed protected entry only. The daemon chooses an admitted root selector,
 * never a path or configuration DTO. Native resolves and checks the actual
 * user's registration/link and obtains local source consent before opening it.
 * Destination storage is local data, separate from source or enrolled state. */
export async function withProtectedSessionSource<A>(startup: Readonly<Omit<T3ProtectedGraphStartup, 'creatorKey'>>,
  admittedRootKey: string, use: (held: HeldSessionInspectionRuntime) => Promise<A>, signal: AbortSignal): Promise<A> {
  return withT3ExecutionResources({ stateDirectory: startup.stateDirectory,
    executorId: startup.executorId, admittedRootKey, signal }, async source => {
    await source.recheck()
    const key = createHash('sha256').update(startup.executorId).digest('hex')
    const storage = await ensureOwnerOnlyStateDirectory(join(homedir(), '.local', 'state', 'nessie-t3-graphs', key))
    await source.recheck()
    return withSessionExecutionState(source, storage,
      state => withHeldSessionInspectionRuntime(source, state, use, signal), signal)
  })
}
