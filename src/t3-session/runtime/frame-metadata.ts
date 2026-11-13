import { createHash } from 'node:crypto'
import { T3ExecutionSerializedFrameSchema, type T3ExecutionSerializedFrame }
  from '@nessie/executor-protocol/t3-session'

/** Projection from actual original encoder bytes. Native independently decodes
 * those same bytes; this projection can neither sign nor authorize a frame. */
export function captureProviderFrameMetadata(driver: string, bytes: Uint8Array): Readonly<T3ExecutionSerializedFrame> {
  const refuse = () => { throw new Error('T3_ORIGINAL_SERIALIZATION_REFUSED') }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse()
  const frameSha256 = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  if (driver === 'codex') {
    if (!('method' in value) || typeof value.method !== 'string' || 'result' in value || 'error' in value) return refuse()
    const protocolId = 'id' in value ? value.id : undefined
    return Object.freeze(T3ExecutionSerializedFrameSchema.parse({ driver, frameSha256,
      kind: value.method === '$/cancelRequest' ? 'cancel' : protocolId === undefined ? 'notification' : 'request',
      method: value.method, ...(protocolId === undefined ? {} : { protocolId }) }))
  }
  if (driver !== 'claude' || !('type' in value)) return refuse()
  if (value.type === 'control_request') {
    if (!('request' in value) || !value.request || typeof value.request !== 'object'
      || !('subtype' in value.request) || !('request_id' in value)) return refuse()
    return Object.freeze(T3ExecutionSerializedFrameSchema.parse({ driver, frameSha256, kind: 'request',
      protocolId: value.request_id, method: value.request.subtype }))
  }
  if (value.type === 'control_cancel_request') {
    if (!('request_id' in value)) return refuse()
    return Object.freeze(T3ExecutionSerializedFrameSchema.parse({ driver, frameSha256, kind: 'cancel',
      protocolId: value.request_id }))
  }
  if (value.type === 'user') return Object.freeze(T3ExecutionSerializedFrameSchema.parse({ driver, frameSha256,
    kind: 'message', ...('uuid' in value ? { messageId: value.uuid } : {}) }))
  // Responses require the existing independent request/answer authority. The
  // bootstrap writer cannot promote an SDK callback into that permission.
  return refuse()
}
