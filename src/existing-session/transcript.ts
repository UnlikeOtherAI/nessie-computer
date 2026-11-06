import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, toNamespacedPath } from 'node:path'
import type { ExecutorSessionConversation, ExecutorSessionMessage } from '@nessie/executor-protocol'

import { nativeIdIsValid, objectOf, type ExistingProvider } from './types.js'

const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 16_000) : ''
const timestamp = (value: unknown): string | null => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}
const asText = (value: unknown): string => typeof value === 'string' ? text(value) : text(JSON.stringify(value ?? ''))

export const nativeTranscriptMessage = (
  provider: ExistingProvider, value: unknown, id: string,
): ExecutorSessionMessage | null => {
  const row = objectOf(value)
  if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) return null
  const native = provider === 'claude' ? objectOf(row.message) : objectOf(row.payload)
  if (provider === 'codex' && row.type !== 'response_item') return null
  const role = provider === 'claude' ? row.type : native.type === 'reasoning' ? 'assistant' : native.role
  let parts: ExecutorSessionMessage['parts'] = []
  if (provider === 'codex' && (native.type === 'function_call' || native.type === 'custom_tool_call')) {
    parts = [{ kind: 'tool_call', name: text(native.name).slice(0, 160), text: asText(native.arguments ?? native.input) }]
  } else if (provider === 'codex' && (native.type === 'function_call_output' || native.type === 'custom_tool_call_output')) {
    parts = [{ kind: 'tool_result', text: asText(native.output) }]
  } else if (provider === 'codex' && native.type === 'reasoning' && Array.isArray(native.summary)) {
    parts = native.summary.map(objectOf).filter((part) => part.type === 'summary_text')
      .map((part) => ({ kind: 'thinking' as const, text: text(part.text) })).slice(0, 32)
  } else if (Array.isArray(native.content)) {
    parts = native.content.map(objectOf).flatMap((part): ExecutorSessionMessage['parts'] => {
      if (['text', 'input_text', 'output_text'].includes(String(part.type))) return [{ kind: 'text', text: text(part.text) }]
      if (part.type === 'thinking') return [{ kind: 'thinking', text: text(part.thinking) }]
      if (part.type === 'tool_use') return [{ kind: 'tool_call', name: text(part.name).slice(0, 160), text: asText(part.input) }]
      if (part.type === 'tool_result') return [{ kind: 'tool_result', text: asText(part.content) }]
      return []
    }).slice(0, 32)
  } else if (typeof native.content === 'string') parts = [{ kind: 'text', text: text(native.content) }]
  if (!parts.length) return null
  return { id, at: timestamp(row.timestamp), role: role === 'user' || role === 'assistant' ? role : 'tool', parts }
}

/** Read a bounded native tail only from an explicitly discovered file inside the provider history root. */
export const readNativeTranscript = async (
  provider: ExistingProvider, historyRoot: string, filename: string, nativeId: string,
): Promise<Pick<ExecutorSessionConversation, 'messages' | 'truncated'> | null> => {
  if (!nativeIdIsValid(nativeId)) return null
  const root = await realpath(historyRoot).catch(() => null)
  const canonical = await realpath(filename).catch(() => null)
  if (!root || !canonical) return null
  const lexical = resolve(filename)
  const fromAlias = relative(toNamespacedPath(resolve(historyRoot)), toNamespacedPath(lexical))
  // Windows provider homes may be junctions. Only that explicit root alias is resolved;
  // a transcript or subdirectory redirect inside it still fails the exact path check.
  const mapped = resolve(root, fromAlias)
  if (toNamespacedPath(canonical) !== toNamespacedPath(lexical)
    && toNamespacedPath(canonical) !== toNamespacedPath(mapped)) return null
  const local = relative(root, canonical)
  if (!local || local.startsWith('..') || isAbsolute(local) || !canonical.endsWith(`${nativeId}.jsonl`)) return null
  const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!file) return null
  try {
    const info = await file.stat()
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return null
    const size = Math.min(info.size, 1024 * 1024)
    const start = info.size - size
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await file.read(buffer, 0, size, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    lines.pop() // A half-written record is picked up on the next observation.
    const messages: ExecutorSessionMessage[] = []
    let byteCount = 0
    let truncated = start > 0
    for (const line of lines) {
      if (line.length > 256_000) { truncated = true; continue }
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      if (provider === 'claude' && objectOf(value).sessionId !== nativeId) continue
      const id = `${nativeId}:${createHash('sha256').update(line).digest('hex').slice(0, 24)}`
      const message = nativeTranscriptMessage(provider, value, id)
      if (line.length > 16_000) truncated = true
      if (!message) continue
      messages.push(message)
      byteCount += Buffer.byteLength(JSON.stringify(message))
      while (messages.length > 200 || byteCount > 192_000) {
        byteCount -= Buffer.byteLength(JSON.stringify(messages.shift()))
        truncated = true
      }
    }
    return { messages, truncated }
  } finally { await file.close() }
}
