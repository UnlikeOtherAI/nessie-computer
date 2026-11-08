import * as Schema from 'effect/Schema'
import { ExecutorT3Routing } from './routing.js'
import { ExecutorT3HttpEndpoints, type ExecutorT3HttpEndpoint } from './http.js'

/** HTTP paging has different codecs from RPC. Do not flatten cursors or boolean flags. */
export const executorT3HistoryTools = () => Object.entries(ExecutorT3HttpEndpoints).map(([endpoint, descriptor]) => {
  const inputCodec = Schema.Struct({
    executorId: ExecutorT3Routing.fields.executorId,
    environmentId: ExecutorT3Routing.fields.environmentId,
    ...(descriptor.params ? { params: descriptor.params } : {}),
    ...(descriptor.query ? { query: descriptor.query } : {}),
  })
  return {
    name: `t3_session_history_${endpoint}`,
    endpoint: endpoint as ExecutorT3HttpEndpoint,
    authority: 'read' as const,
    kind: 'finite' as const,
    receipt: 'none' as const,
    inputCodec,
  }
})

// Authentication and protocol headers are supplied by the admitted gateway,
// not accepted from a tool. All five endpoints remain unbound at this base.
