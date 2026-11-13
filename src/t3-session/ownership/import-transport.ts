import { executorApi } from '../../api-client.js'
import { loadExecutorState } from '../../state-store.js'
import { signExecutorDaemonPayload } from '../../daemon-signature.js'
import { requireCapture } from '../state/sqlite.js'

/** One concrete authenticated daemon transport; no injected trust callbacks,
 * user-supplied URL, caller identity or alternate credential store.
 */
export async function retainedImportPost(stateDirectory: string, operation: Record<string, unknown>) {
  const state = await loadExecutorState(stateDirectory)
  requireCapture(state.executorId && state.connectionEpoch, 'retained_import_connection_unavailable')
  const payload = { ...operation, executorId: state.executorId,
    connectionEpoch: state.connectionEpoch, observedAt: new Date().toISOString() }
  const signature = signExecutorDaemonPayload(state.machinePrivateKey, 'retained_import', payload)
  return executorApi.retainedImport(state.apiBaseUrl, { ...payload, signature })
}
