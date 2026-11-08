import type { ExecutorT3LaneOperation } from './lane.js'
import { executorT3RpcInputPolicy } from './operation-policy.js'

/** Implementation ceiling of the held retained graph. This is not entitlement,
 * native execution readiness or a promise that source/target admission succeeds.
 * Expanding beyond retained reads requires an explicit capability contract.
 */
export function isRetainedT3LaneOperation(request: ExecutorT3LaneOperation): boolean {
  if (request.kind === 'http-request') {
    switch (request.endpoint) {
      case 'shellSnapshot': case 'threadSnapshot': case 'threadTranscript':
      case 'threadBoundedSnapshot': case 'threadHistoryPage': return true
      default: return false
    }
  }
  if (executorT3RpcInputPolicy(request).receipt !== 'none') return false
  switch (request.method) {
    case 'orchestration.getArchivedShellSnapshot': case 'orchestration.getThreadFamily':
    case 'orchestration.getOlderSettledThreads': case 'orchestration.getThreadTitles':
    case 'orchestration.getWorktreeThreadIds': case 'orchestration.getThreadProjection':
    case 'orchestration.getTurnItem': case 'orchestration.searchThread': return true
    default: return false
  }
}
