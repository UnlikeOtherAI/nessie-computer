import { createHash } from 'node:crypto'
import { isRetainedT3LaneOperation, T3_FINITE_FRAGMENT_LIMITS, T3_LANE_LIMITS,
  type ExecutorT3LaneOperation, type ExecutorT3LaneReplyEncoded, type T3FiniteFragment,
} from '@nessie/executor-protocol/t3-session'

let heldBytes = 0
const inlineBytes = T3_LANE_LIMITS.frameBytes - 16_384
export class T3FiniteReplyCapacityError extends Error {
  constructor() { super('T3_FINITE_REPLY_CAPACITY') }
}

/** Stop serialization when a lower bound already exceeds the finite ceiling.
 * Original codec output is not normalized, sorted or otherwise rewritten.
 */
function boundedJson(value: ExecutorT3LaneReplyEncoded, limit: number): string {
  let lowerBound = 0
  const text = JSON.stringify(value, function (key, item: unknown) {
    if (key && !Array.isArray(this)) lowerBound += Buffer.byteLength(key) + 3
    if (typeof item === 'string') lowerBound += Buffer.byteLength(item) + 2
    else if (item === null || typeof item === 'number' || typeof item === 'boolean') lowerBound += String(item).length
    if (lowerBound > limit) throw new T3FiniteReplyCapacityError()
    return item
  })
  if (Buffer.byteLength(text) > limit) throw new T3FiniteReplyCapacityError()
  return text
}

export type T3RetainedFiniteReply = { at(index: number): T3FiniteFragment; close(): void }

/** The original held reader is pulled once. Later credits slice this one exact
 * encoded reply; no recapture, repeated original operation or alternate stream.
 */
export function retainT3FiniteReply(request: ExecutorT3LaneOperation,
  reply: ExecutorT3LaneReplyEncoded): T3RetainedFiniteReply | null {
  const available = T3_FINITE_FRAGMENT_LIMITS.bufferedBytes - heldBytes
  const text = boundedJson(reply, Math.max(inlineBytes, Math.min(T3_FINITE_FRAGMENT_LIMITS.totalBytes, available)))
  const size = Buffer.byteLength(text)
  if (size <= inlineBytes) return null
  if (!isRetainedT3LaneOperation(request)) throw new Error('T3_FINITE_FRAGMENT_OPERATION_UNBOUND')
  if (size > available) throw new T3FiniteReplyCapacityError()
  let bytes: Buffer | undefined = Buffer.from(text, 'utf8')
  heldBytes += size
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  const count = Math.ceil(size / T3_FINITE_FRAGMENT_LIMITS.bytes)
  return {
    at(index) {
      if (!bytes || !Number.isSafeInteger(index) || index < 0 || index >= count) {
        throw new Error('T3_FINITE_FRAGMENT_ORDINAL')
      }
      return { version: 1, encoding: 'base64', digest, totalBytes: size, count, index,
        data: bytes.subarray(index * T3_FINITE_FRAGMENT_LIMITS.bytes,
          Math.min(size, (index + 1) * T3_FINITE_FRAGMENT_LIMITS.bytes)).toString('base64') }
    },
    close() { if (bytes) { heldBytes -= size; bytes = undefined } },
  }
}
