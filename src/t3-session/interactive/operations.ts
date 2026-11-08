import { WsRpcGroup } from '@nessie/t3-session-source/contracts'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcSchema from 'effect/rpc/RpcSchema'
import * as Schema from 'effect/Schema'

type OriginalRpc = RpcGroup.Rpcs<typeof WsRpcGroup>
type Method = OriginalRpc['_tag']
type Policy = { readonly access: 'read' | 'operate'; readonly kind: 'finite' | 'stream' }

/** Inventory, not registration or authorization. Native/gateway owners are still required. */
export const interactiveOperations = {
  'terminal.open': { access: 'operate', kind: 'finite' },
  'terminal.attach': { access: 'operate', kind: 'stream' },
  'terminal.observe': { access: 'read', kind: 'stream' },
  'terminal.write': { access: 'operate', kind: 'finite' },
  'terminal.resize': { access: 'operate', kind: 'finite' },
  'terminal.clear': { access: 'operate', kind: 'finite' },
  'terminal.close': { access: 'operate', kind: 'finite' },
  subscribeTerminalMetadata: { access: 'read', kind: 'stream' },
  'preview.open': { access: 'operate', kind: 'finite' },
  'preview.resize': { access: 'operate', kind: 'finite' },
  'preview.adjust': { access: 'operate', kind: 'finite' },
  'preview.close': { access: 'operate', kind: 'finite' },
  'preview.list': { access: 'read', kind: 'finite' },
  subscribePreviewEvents: { access: 'read', kind: 'stream' },
  'device.list': { access: 'read', kind: 'finite' },
  'device.open': { access: 'operate', kind: 'finite' },
  'device.close': { access: 'operate', kind: 'finite' },
  'device.detail': { access: 'read', kind: 'finite' },
  'device.action': { access: 'operate', kind: 'finite' },
  subscribeDeviceState: { access: 'read', kind: 'stream' },
} as const satisfies Partial<Record<Method, Policy>>

export type InteractiveMethod = keyof typeof interactiveOperations
export type InteractiveDescriptor<M extends InteractiveMethod> = Extract<OriginalRpc, { readonly _tag: M }>
export type InteractiveInput<M extends InteractiveMethod> = InteractiveDescriptor<M>['payloadSchema']['Type']
type Success<M extends InteractiveMethod> = InteractiveDescriptor<M>['successSchema']
export type InteractiveResult<M extends InteractiveMethod> = Success<M> extends RpcSchema.Stream<infer A, infer _E>
  ? A['Type'] : Success<M>['Type']
export type InteractiveRequest = { [M in InteractiveMethod]: {
  readonly method: M; readonly input: InteractiveInput<M>
} }[InteractiveMethod]

export function interactiveDescriptor<M extends InteractiveMethod>(method: M): InteractiveDescriptor<M> {
  const descriptor = [...WsRpcGroup.requests.values()].find(
    (rpc): rpc is InteractiveDescriptor<M> => rpc._tag === method,
  )
  if (!descriptor) throw new Error('interactive_source_descriptor_missing')
  return descriptor
}

/** Canonical UI/WebMCP/internal/external MCP inventory. Consumers must use T09 admission,
 * not register these raw descriptors as callable host handlers.
 */
export function interactiveOperationContract<M extends InteractiveMethod>(method: M) {
  const policy = interactiveOperations[method]
  return {
    method, descriptor: interactiveDescriptor(method), ...policy,
    binding: 'required_unbound' as const,
    receipt: policy.access === 'operate' ? 'durable_operation_identity' as const : 'none' as const,
    retry: policy.access === 'operate' ? 'reconcile_same_operation_no_blind_replay' as const
      : 'renew_admission_resume_source' as const,
    result: policy.kind === 'stream' ? 'bounded_resource_handle' as const : 'original_codec' as const,
    grant: 'exact_executor_environment_thread_resource_and_current_epoch' as const,
  }
}

/** Decode at the original boundary. Unknown properties cannot smuggle install/retry options. */
export function decodeInteractiveInput<M extends InteractiveMethod>(method: M, value: unknown): InteractiveInput<M> {
  try {
    return Schema.decodeUnknownSync(interactiveDescriptor(method).payloadSchema)(value, { onExcessProperty: 'error' })
  } catch {
    // Original schema errors can embed input values; the transport must not retain them.
    throw new InteractiveFailure('invalid_input')
  }
}

export type InteractiveFailureCode = 'resource_mismatch' | 'operate_required' | 'unsupported_operation'
  | 'resource_expired' | 'stream_capacity' | 'invalid_ack' | 'stream_closed' | 'invalid_voice_state'
  | 'invalid_pcm' | 'source_sequence_regressed' | 'invalid_input'

/** No input, transcript, URLs or host paths in boundary errors. */
export class InteractiveFailure extends Error {
  constructor(readonly code: InteractiveFailureCode) { super(code); this.name = 'InteractiveFailure' }
}

export function requireInteractive(condition: unknown, code: InteractiveFailureCode): asserts condition {
  if (!condition) throw new InteractiveFailure(code)
}
