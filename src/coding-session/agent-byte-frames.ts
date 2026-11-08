/** Protocol framing only. Neither a parsed message nor its ID establishes operation authority. */
export const AGENT_FRAME_BYTES = 128 * 1024
export type AgentFrameBytes = Uint8Array | readonly Uint8Array[]
export type ProviderRequestId = string | number

export class AgentFrameRefused extends Error {
  constructor() { super('Provider frame is incomplete, ambiguous, oversized or uncorrelated') }
}

const rejectDuplicateKeys = (text: string): void => {
  const stack: { keys?: Set<string>; wantsKey: boolean }[] = []
  // JSON.parse has already validated grammar. This pass detects duplicate escaped keys
  // which JSON.parse would silently overwrite, including nested request arguments.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]/gu)) {
    const token = match[0], current = stack.at(-1)
    if (token === '{' || token === '[') stack.push({ ...(token === '{' ? { keys: new Set<string>() } : {}), wantsKey: true })
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ',') { if (current) current.wantsKey = true }
    else if (token === ':') { if (current) current.wantsKey = false }
    else if (current?.keys && current.wantsKey) {
      const name = JSON.parse(token) as string
      if (current.keys.has(name)) throw new AgentFrameRefused()
      current.keys.add(name)
      current.wantsKey = false
    }
  }
}

export const readAgentFrame = (chunks: AgentFrameBytes): { text: string; value: Record<string, unknown> } => {
  const parts = chunks instanceof Uint8Array ? [chunks] : chunks
  if (parts.length > AGENT_FRAME_BYTES) throw new AgentFrameRefused()
  let size = 0
  for (const part of parts) {
    size += part.byteLength
    if (size > AGENT_FRAME_BYTES) throw new AgentFrameRefused()
  }
  // Copy before enqueueing. A caller cannot change bytes while authority is being consumed.
  const bytes = Buffer.concat(parts.map(part => Buffer.from(part)), size)
  if (!size || bytes[size - 1] !== 10 || bytes.subarray(0, -1).includes(10)) throw new AgentFrameRefused()
  // Decode only the complete logical frame: UTF8 code points may cross any supplied chunk boundary.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new AgentFrameRefused()
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentFrameRefused()
  rejectDuplicateKeys(text)
  return { text, value: value as Record<string, unknown> }
}

const requestId = (value: unknown): value is ProviderRequestId =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
  || typeof value === 'number' && Number.isSafeInteger(value)
const key = (id: ProviderRequestId): string => JSON.stringify([typeof id, id])

/** Observes actual stdout without changing bytes or requiring the consumer to read lines. */
export class ProviderReplyLedger {
  #partial = Buffer.alloc(0)
  #usable = true
  #pending = new Map<string, { id: ProviderRequestId; at: number }>()
  constructor(private readonly driver: 'codex' | 'claude') {}

  close(): void { this.#usable = false; this.#partial = Buffer.alloc(0); this.#pending.clear() }

  observe(chunk: Uint8Array): void {
    if (!this.#usable) return
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let start = 0
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start)
      const part = bytes.subarray(start, end < 0 ? bytes.length : end + 1)
      if (this.#partial.length + part.length > AGENT_FRAME_BYTES) { this.close(); return }
      this.#partial = Buffer.concat([this.#partial, part])
      if (end < 0) return
      try {
        const { value } = readAgentFrame(this.#partial)
        const id = this.driver === 'codex'
          ? typeof value.method === 'string' && !('result' in value) && !('error' in value) ? value.id : undefined
          : value.type === 'control_request' ? value.request_id : undefined
        if (id !== undefined) {
          if (!requestId(id) || this.#pending.has(key(id)) || this.#pending.size >= 256) { this.close(); return }
          this.#pending.set(key(id), { id, at: performance.now() })
        }
        if (this.driver === 'claude' && value.type === 'control_cancel_request' && requestId(value.request_id)) {
          this.#pending.delete(key(value.request_id))
        }
      } catch { this.close(); return }
      this.#partial = Buffer.alloc(0)
      start = end + 1
    }
  }

  /** Only a fixed unsupported response is automatic. Decisions/results require their own finite operation. */
  unsupported(id: ProviderRequestId): string {
    const pending = this.#pending.get(key(id))
    if (!this.#usable || !pending || performance.now() - pending.at >= 30_000) throw new AgentFrameRefused()
    // Remove before dispatch: an uncertain ACK must never make this request replyable again.
    this.#pending.delete(key(id))
    return JSON.stringify(this.driver === 'codex'
      ? { id: pending.id, error: { code: -32601, message: 'Unsupported provider request' } }
      : { type: 'control_response', response: {
        subtype: 'error', request_id: pending.id, error: 'Unsupported provider request',
      } }) + '\n'
  }

  /** A finite human response and an automatic response cannot both answer the same provider request. */
  claimResponse(value: Record<string, unknown>): void {
    const response = value.response
    const isResponse = this.driver === 'codex' ? !('method' in value) && ('result' in value || 'error' in value)
      : value.type === 'control_response'
    if (!isResponse) return
    const id = this.driver === 'codex' ? value.id
      : response && typeof response === 'object' && 'request_id' in response ? response.request_id : undefined
    if (!this.#usable || !requestId(id) || !this.#pending.delete(key(id))) throw new AgentFrameRefused()
  }
}
