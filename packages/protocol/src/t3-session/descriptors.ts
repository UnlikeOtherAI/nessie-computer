import { WsRpcGroup } from '@nessie/t3-session-source/contracts'
import type * as RpcGroup from 'effect/rpc/RpcGroup'

export type OriginalRpc = RpcGroup.Rpcs<typeof WsRpcGroup>
export type OriginalMethod = OriginalRpc['_tag']

/** A checked discriminator preserves the descriptor relation without a cast. */
export const originalRpc = <Tag extends OriginalMethod>(tag: Tag): Extract<OriginalRpc, { readonly _tag: Tag }> => {
  const descriptor = [...WsRpcGroup.requests.values()].find(
    (rpc): rpc is Extract<OriginalRpc, { readonly _tag: Tag }> => rpc._tag === tag,
  )
  if (!descriptor) throw new Error('T3_SOURCE_DESCRIPTOR_MISSING')
  return descriptor
}
