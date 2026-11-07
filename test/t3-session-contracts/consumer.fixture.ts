// Compiled through the real package export maps in NodeNext and Bundler modes.
import * as Schema from 'effect/Schema'
import { ThreadId, OrchestrationV2Command, WsRpcGroup } from '@nessie/t3-session-source/contracts'
import { ServerSettingsPatch } from '@nessie/t3-session-source/contracts/settings'
import type { ExecutorT3Request, ExecutorT3RequestEncoded, ExecutorT3Result,
  ExecutorT3HttpInput } from '@nessie/executor-protocol/t3-session'

type Projection = Extract<ExecutorT3Request, { method: 'orchestration.getThreadProjection' }>
type ProjectionWire = Extract<ExecutorT3RequestEncoded, { method: 'orchestration.getThreadProjection' }>
export const projection: Projection['input'] = { threadId: ThreadId.make('opaque:thread') }
export const wire: ProjectionWire['input'] = { threadId: 'opaque:thread' }
// @ts-expect-error Decoded source IDs retain their original brand.
export const unbranded: Projection['input'] = { threadId: 'opaque:thread' }
// @ts-expect-error A different method's body cannot satisfy this method.
export const wrongMethod: ProjectionWire['input'] = { threadIds: ['opaque:thread'] }

export const search = WsRpcGroup.requests.get('orchestration.searchThreads')
export const searchStream = WsRpcGroup.requests.get('orchestration.searchThreadStream')
type Stream = Extract<ExecutorT3Result, { method: 'orchestration.subscribeThread' }>
export const streamKind: Stream['kind'] = 'stream'
// @ts-expect-error Original stream descriptors do not produce finite results.
export const finiteKind: Stream['kind'] = 'result'

export const http: ExecutorT3HttpInput<'threadBoundedSnapshot'>['query'] = { compactIds: '1' }
// @ts-expect-error Original HTTP query flags are strings, not RPC booleans.
export const booleanHttp: ExecutorT3HttpInput<'threadBoundedSnapshot'>['query'] = { compactIds: true }
type Subscribe = Extract<ExecutorT3RequestEncoded, { method: 'orchestration.subscribeThread' }>
export const rpc: Subscribe['input'] = { threadId: 'opaque:thread', acceptCompactIds: true }
// @ts-expect-error RPC flags preserve the original boolean encoding.
export const stringRpc: Subscribe['input'] = { threadId: 'opaque:thread', acceptCompactIds: '1' }

type Settle = Extract<typeof OrchestrationV2Command.Type, { type: 'thread.settle' }>
// @ts-expect-error Decoded dates are original Effect DateTime values.
export const date: Settle['settledAt'] = '2026-11-07T12:00:00Z'
export const settings = Schema.decodeUnknownSync(ServerSettingsPatch)({ setModelsHidden: [] })
