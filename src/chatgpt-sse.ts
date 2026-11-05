import { ChatgptError, chatgptProtocolError } from './chatgpt-errors.js'

const MAX_EVENT_BYTES = 4 * 1024 * 1024
const MAX_STREAM_BYTES = 32 * 1024 * 1024

/** Chunk boundaries, CRLF and multiline data are transport facts, never JSON boundaries. */
export const chatgptSseData = async function* (response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) return chatgptProtocolError()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let data: string[] = []
  let eventBytes = 0
  let streamBytes = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw new ChatgptError('chatgpt_cancelled', 'unknown')
      const next = await reader.read()
      if (next.done) break
      streamBytes += next.value.byteLength
      if (streamBytes > MAX_STREAM_BYTES) return chatgptProtocolError()
      pending += decoder.decode(next.value, { stream: true })
      for (;;) {
        const index = pending.indexOf('\n')
        if (index < 0) break
        const line = pending.slice(0, index).replace(/\r$/, '')
        pending = pending.slice(index + 1)
        if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) return chatgptProtocolError()
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []; eventBytes = 0
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          eventBytes += Buffer.byteLength(value, 'utf8')
          if (eventBytes > MAX_EVENT_BYTES) return chatgptProtocolError()
          data.push(value)
        }
      }
      if (Buffer.byteLength(pending, 'utf8') + eventBytes > MAX_EVENT_BYTES) return chatgptProtocolError()
    }
    if (signal.aborted) throw new ChatgptError('chatgpt_cancelled', 'unknown')
    pending += decoder.decode()
    // An unfinished event must not be silently accepted at EOF.
    if (pending || data.length) return chatgptProtocolError()
  } catch (error) {
    if (error instanceof ChatgptError) throw error
    throw new ChatgptError(signal.aborted ? 'chatgpt_cancelled' : 'chatgpt_protocol_error', 'unknown')
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
