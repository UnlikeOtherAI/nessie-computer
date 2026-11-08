import type { FileHandle } from 'node:fs/promises'
import { objectOf } from '../../../existing-session/types.js'
import { withClaudeFile } from './files.js'

export interface ClaudeHistoryRecord {
  readonly offset: number
  readonly id: string | null
  readonly parentId: string | null
  readonly role: 'user' | 'assistant' | null
  readonly parts: readonly (
    { readonly kind: 'text' | 'thinking'; readonly text: string }
    | { readonly kind: 'tool_call'; readonly id: string | null; readonly name: string | null;
      readonly withheld: 'native_tool_privacy_unbound' }
    | { readonly kind: 'tool_result'; readonly id: string | null; readonly withheld: 'native_tool_privacy_unbound' }
  )[]
  readonly fidelity: 'supported' | 'withheld' | 'unsupported'
}
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null
const MAX_RECORD_BYTES = 512 * 1024
const PAGE_BYTES = 1024 * 1024

/** Preserve supported native text without tail/part/string truncation. Native
 * tool payloads require the canonical privacy adapter; their names and exact
 * correlation IDs survive, but input/result/default/answer values never escape.
 * Excluded usage/account/system metadata is never copied into this projection. */
function projectRecord(value: unknown, offset: number, nativeId: string): ClaudeHistoryRecord {
  const row = objectOf(value)
  if (row.sessionId !== undefined && row.sessionId !== nativeId) throw new Error('claude_history_identity_mismatch')
  const role = row.type === 'user' || row.type === 'assistant' ? row.type : null
  const base = { offset, id: stringOrNull(row.uuid), parentId: stringOrNull(row.parentUuid), role }
  if (!role || row.isMeta === true) return { ...base, parts: [], fidelity: 'unsupported' }
  const content = objectOf(row.message).content
  if (typeof content === 'string') return { ...base, parts: [{ kind: 'text', text: content }], fidelity: 'supported' }
  if (!Array.isArray(content)) return { ...base, parts: [], fidelity: 'unsupported' }
  const parts: ClaudeHistoryRecord['parts'][number][] = []
  let fidelity: ClaudeHistoryRecord['fidelity'] = 'supported'
  for (const item of content) {
    const part = objectOf(item)
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ kind: 'text', text: part.text })
    else if (part.type === 'thinking' && typeof part.thinking === 'string') parts.push({ kind: 'thinking', text: part.thinking })
    else if (part.type === 'tool_use') {
      parts.push({ kind: 'tool_call', id: stringOrNull(part.id), name: stringOrNull(part.name),
        withheld: 'native_tool_privacy_unbound' })
      fidelity = 'withheld'
    } else if (part.type === 'tool_result') {
      parts.push({ kind: 'tool_result', id: stringOrNull(part.tool_use_id), withheld: 'native_tool_privacy_unbound' })
      fidelity = 'withheld'
    } else if (fidelity !== 'withheld') fidelity = 'unsupported'
  }
  return { ...base, parts, fidelity }
}

async function readLine(file: FileHandle, start: number, size: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let length = 0
  while (start + length < size) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, size - start - length, MAX_RECORD_BYTES + 1 - length))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start + length)
    if (!bytesRead) throw new Error('claude_history_changed_or_unavailable')
    const bytes = buffer.subarray(0, bytesRead)
    const newline = bytes.indexOf(10)
    chunks.push(newline < 0 ? bytes : bytes.subarray(0, newline + 1))
    length += newline < 0 ? bytes.length : newline + 1
    if (length > MAX_RECORD_BYTES) throw new Error('claude_history_record_too_large')
    if (newline >= 0) return Buffer.concat(chunks)
  }
  return null // A partial last record is retained at the same byte cursor.
}

export async function readClaudeHistoryPage(input: {
  root: string; local: string; nativeId: string; revision: string; offset: number; limit: number
  recheck: () => Promise<void>
}) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new Error('claude_history_page_invalid')
  return withClaudeFile(input.root, input.local, input.revision, input.recheck, async (file, size, revision) => {
    if (input.offset > size) throw new Error('claude_history_cursor_invalid')
    if (input.offset > 0) {
      const previous = Buffer.alloc(1)
      await file.read(previous, 0, 1, input.offset - 1)
      if (previous[0] !== 10) throw new Error('claude_history_cursor_invalid')
    }
    const records: ClaudeHistoryRecord[] = []
    let offset = input.offset
    let partial = false
    while (offset < size && records.length < input.limit && offset - input.offset < PAGE_BYTES) {
      await input.recheck()
      const bytes = await readLine(file, offset, size)
      if (!bytes) { partial = true; break }
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch { throw new Error('claude_history_record_invalid') }
      records.push(projectRecord(value, offset, input.nativeId))
      offset += bytes.length
    }
    return { records, revision, nextOffset: offset < size ? offset : null,
      complete: offset === size, partialLastRecord: partial,
      fidelity: records.every(row => row.fidelity === 'supported') ? 'supported' as const : 'partial' as const }
  })
}
