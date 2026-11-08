import { ExecutorT3Descriptors, ExecutorT3HttpEndpoints,
  type ExecutorT3Descriptor } from '@nessie/executor-protocol/t3-session'

/** Shared operation inventory for the dispatcher, gateway, UI, WebMCP and MCP.
 * Entries describe contracts, not capability advertisement or a grant.
 */
export const retainedCatalogRpcMethods = [
  'orchestration.getArchivedShellSnapshot', 'orchestration.getThreadFamily',
  'orchestration.getOlderSettledThreads', 'orchestration.getThreadTitles',
  'orchestration.getWorktreeThreadIds', 'orchestration.getThreadProjection',
  'orchestration.getTurnItem', 'orchestration.searchThread',
] as const
export type RetainedCatalogRpcMethod = typeof retainedCatalogRpcMethods[number]
export type RetainedCatalogInput<M extends RetainedCatalogRpcMethod> = ExecutorT3Descriptor<M>['payloadSchema']['Type']
export type RetainedCatalogOutput<M extends RetainedCatalogRpcMethod> = ExecutorT3Descriptor<M>['successSchema']['Type']

export const retainedCatalogReadPolicy = {
  source: 't3', authority: 'canonical-source-or-import-grant-and-selected-team-read',
  capture: 'exact-published-generation', receipt: 'none-read-only',
  retry: 'same-source-generation-selection-revision-and-original-cursor-or-restart',
  cancellation: 'abort-signal-no-result-after-cancellation',
  transport: 'required-unbound-admitted-executor-dispatcher',
} as const

export const retainedCatalogOperations = {
  rpc: Object.fromEntries(retainedCatalogRpcMethods.map(method => [method, {
    descriptor: ExecutorT3Descriptors[method], mode: 'finite' as const,
    ...retainedCatalogReadPolicy,
  }])),
  http: ExecutorT3HttpEndpoints,
  // A retained capture has no live writer or output hub. Do not substitute a
  // one-frame stream, poll snapshots, or collect an unbounded stream for MCP.
  streams: {
    'orchestration.subscribeShell': { mode: 'stream', prerequisite: 'admitted-live-runtime-and-replay' },
    'orchestration.subscribeThread': { mode: 'stream', prerequisite: 'admitted-live-runtime-and-replay' },
    'orchestration.subscribeCommandOutput': { mode: 'stream', prerequisite: 'admitted-live-command-output-hub' },
    'orchestration.searchThreadStream': { mode: 'stream', prerequisite: 'bounded-authorized-stream-relay' },
  },
} as const
