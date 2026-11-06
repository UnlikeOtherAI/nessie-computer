import type { ExecutorSessionConversation, ExecutorSessionMessage } from '@nessie/executor-protocol'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 16_000) : ''

/** The host's already-redacted event log is also the person's conversation history. */
export const codingConversation = (value: unknown): ExecutorSessionConversation => {
  const result = object(value)
  const events = Array.isArray(result.events) ? result.events : []
  const messages: ExecutorSessionMessage[] = events.flatMap((value): ExecutorSessionMessage[] => {
    const event = object(value)
    const at = typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? event.at : null
    const id = String(event.seq ?? '').slice(0, 160)
    if (!id) return []
    if (event.kind === 'user' || event.kind === 'assistant') return [{ id, at, role: event.kind,
      parts: [{ kind: 'text', text: text(event.text) }] }]
    if (event.kind === 'tool' || event.kind === 'tool_result') return [{ id, at, role: 'tool',
      parts: [{ kind: event.kind === 'tool' ? 'tool_call' : 'tool_result', text: text(event.summary),
        ...(typeof event.name === 'string' ? { name: event.name.slice(0, 160) } : {}) }] }]
    return []
  }).slice(-200)
  return {
    messages, truncated: events.length > 200 || result.truncated === true,
    capturedAt: new Date().toISOString(),
    sendMode: result.status === 'closed' || result.status === 'failed' ? null : 'managed',
    canInterrupt: result.status === 'working' || result.status === 'starting',
  }
}
