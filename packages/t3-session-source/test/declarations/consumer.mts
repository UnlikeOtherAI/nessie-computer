import * as Schema from 'effect/Schema'
import { ThreadId, GuestStreamEvent, OrchestrationV2ThreadStreamItem, WsRpcGroup,
  EnvironmentHttpApi, RpcScopeAuthorization } from '@nessie/t3-session-source/contracts'

export * as Settings from '@nessie/t3-session-source/contracts/settings'
export * as Relay from '@nessie/t3-session-source/contracts/relay'
export { WsRpcGroup, EnvironmentHttpApi, RpcScopeAuthorization }
export type Requests = typeof WsRpcGroup.requests
export type GuestEncoded = typeof GuestStreamEvent.Encoded
export type StreamEncoded = typeof OrchestrationV2ThreadStreamItem.Encoded
export const decodeGuest: ReturnType<typeof Schema.decodeUnknownEffect<typeof GuestStreamEvent>> =
  Schema.decodeUnknownEffect(GuestStreamEvent)

export function sharedThread(event: GuestStreamEvent): OrchestrationV2ThreadStreamItem | undefined {
  return event.type === 'thread' ? event.item : undefined
}
export function serviceIdentity(service: RpcScopeAuthorization): RpcScopeAuthorization {
  return service
}

// @ts-expect-error The original brand excludes an ordinary string.
const invalidId: ThreadId = 'arbitrary-string'
// @ts-expect-error Original stream discriminants must survive declaration extraction.
const invalidGuest: GuestStreamEvent = { type: 'thread', item: { kind: 'invented' } }
// @ts-expect-error The encoded union must retain its original member fields.
const invalidEncoded: GuestEncoded = { type: 'ended', view: {} }
void [invalidId, invalidGuest, invalidEncoded]
