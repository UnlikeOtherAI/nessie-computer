import type * as Effect from 'effect/Effect'
import type * as Stream from 'effect/Stream'
import type * as RpcSchema from 'effect/rpc/RpcSchema'
import type { ExecutorT3Method, ExecutorT3Descriptor } from './methods.js'

type Descriptor<M extends ExecutorT3Method> = ExecutorT3Descriptor<M>
type Handler<M extends ExecutorT3Method> = (input: Descriptor<M>['payloadSchema']['Type']) =>
  Descriptor<M>['successSchema'] extends RpcSchema.Stream<infer A, infer E>
    ? Stream.Stream<A['Type'], E['Type'] | Descriptor<M>['errorSchema']['Type']>
    : Effect.Effect<Descriptor<M>['successSchema']['Type'], Descriptor<M>['errorSchema']['Type']>

/** Empty until the resource/engine owner supplies a real admitted implementation. */
export type ExecutorT3ImplementationSlots = { readonly [M in ExecutorT3Method]?: Handler<M> }

export const requireBoundExecutorT3Operation = <M extends ExecutorT3Method>(
  slots: ExecutorT3ImplementationSlots, method: M,
): NonNullable<ExecutorT3ImplementationSlots[M]> => {
  const implementation = slots[method]
  if (!implementation) throw new Error('T3_OPERATION_NOT_BOUND')
  return implementation
}
