import { codexIdentityKey, requireCodex, type CodexNativeIdentity } from './identity.js'
import { CodexHistoryPrivacy } from './privacy.js'
import { parseCodexRolloutLine, projectCodexRecord, type CodexRolloutRecord } from './rollout.js'

/** Data-plane view of an ALREADY held read resource. This interface is not an admission producer.
 * The shared native-history port must establish resource and original-human continuity before
 * constructing it, keep the immutable prefix stable and invalidate it on replacement/revocation.
 */
export interface CodexRolloutBytes {
  readonly identity: CodexNativeIdentity
  readonly resourceRevision: string
  readonly capturedBytes: number
  read(offset: number, length: number): Promise<Uint8Array>
  recheck(): Promise<void>
}

export interface CodexHistoryCursor {
  readonly sourceKey: string
  readonly resourceRevision: string
  readonly capturedBytes: number
  readonly offset: number
}

export interface CodexHistoryEntry {
  /** Source byte position is separate from original payload IDs and T3 positions. */
  readonly offset: number
  readonly nextOffset: number
  readonly record: CodexRolloutRecord | null
  readonly omission: 'excluded' | 'unsupported' | null
}

const CHUNK = 64 * 1024
const RECORD_LIMIT = 1024 * 1024

/** Complete forward JSONL traversal with byte cursors; it never seeks to a recent tail.
 * A partial final record is explicitly incomplete, not malformed or silently dropped.
 */
async function* lines(source: CodexRolloutBytes, start: number): AsyncGenerator<{
  offset: number; nextOffset: number; record: CodexRolloutRecord
}> {
  let readAt = start
  let offset = start
  let pending = Buffer.alloc(0)
  while (readAt < source.capturedBytes) {
    await source.recheck()
    const length = Math.min(CHUNK, source.capturedBytes - readAt)
    const chunk = await source.read(readAt, length)
    requireCodex(chunk.byteLength === length, 'codex_capture_changed')
    readAt += length
    pending = Buffer.concat([pending, chunk])
    let end = pending.indexOf(10)
    while (end >= 0) {
      requireCodex(end <= RECORD_LIMIT, 'codex_record_too_large')
      let decoded: string
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, end)) }
      catch { requireCodex(false, 'codex_record_invalid_utf8') }
      const nextOffset = offset + end + 1
      yield { offset, nextOffset, record: parseCodexRolloutLine(decoded) }
      pending = pending.subarray(end + 1)
      offset = nextOffset
      end = pending.indexOf(10)
    }
    requireCodex(pending.length <= RECORD_LIMIT, 'codex_record_too_large')
  }
  await source.recheck()
}

/** The capture owner must keep this instance within its live shared-port callback.
 * There is no filesystem opening, provider start, resume, queue, credential or persistent write here.
 */
export class CodexRetainedHistory {
  private readonly privacy = new CodexHistoryPrivacy()
  private ready = false
  private attempted = false
  private throughOffset = 0
  private unsupportedRecords = 0
  private readonly source: CodexRolloutBytes

  constructor(source: CodexRolloutBytes) { this.source = source }

  async prepare(): Promise<void> {
    requireCodex(!this.attempted, 'codex_history_requires_fresh_capture')
    this.attempted = true
    const { source } = this
    requireCodex(Number.isSafeInteger(source.capturedBytes) && source.capturedBytes > 0 &&
      source.resourceRevision.length > 0, 'codex_capture_invalid')
    await source.recheck()
    let first = true
    for await (const line of lines(source, 0)) {
      if (first) requireCodex(line.record.type === 'session_meta' &&
        line.record.payload.id === source.identity.nativeId, 'codex_rollout_identity_mismatch')
      // A second header can describe copied fork ancestry, but cannot silently rebind this file.
      if (!first && line.record.type === 'session_meta') requireCodex(
        line.record.payload.id === source.identity.nativeId, 'codex_rollout_identity_conflict')
      first = false
      this.privacy.observe(line.record)
      if (projectCodexRecord(line.record).omission === 'unsupported') this.unsupportedRecords++
      this.throughOffset = line.nextOffset
    }
    requireCodex(!first, 'codex_rollout_header_incomplete')
    this.privacy.complete()
    await source.recheck()
    this.ready = true
  }

  async page(input: {
    readonly cursor?: CodexHistoryCursor; readonly limit?: number; readonly byteLimit?: number
  } = {}) {
    requireCodex(this.ready, 'codex_history_preflight_required')
    const { source } = this
    const key = codexIdentityKey(source.identity)
    const limit = input.limit ?? 64
    const byteLimit = input.byteLimit ?? 2 * 1024 * 1024
    requireCodex(Number.isSafeInteger(limit) && limit > 0 && limit <= 256 &&
      Number.isSafeInteger(byteLimit) && byteLimit >= RECORD_LIMIT + 1024 && byteLimit <= 4 * RECORD_LIMIT,
    'codex_page_limit_invalid')
    const cursor = input.cursor
    const start = cursor?.offset ?? 0
    requireCodex(!cursor || (cursor.sourceKey === key && cursor.resourceRevision === source.resourceRevision &&
      cursor.capturedBytes === source.capturedBytes && Number.isSafeInteger(start) && start >= 0 &&
      start <= this.throughOffset), 'codex_cursor_stale')
    await source.recheck()
    if (start > 0) {
      const boundary = await source.read(start - 1, 1)
      requireCodex(boundary.length === 1 && boundary[0] === 10, 'codex_cursor_not_record_boundary')
    }
    const entries: CodexHistoryEntry[] = []
    let bytes = 0
    let nextOffset = start
    for await (const line of lines(source, start)) {
      const selected = projectCodexRecord(line.record)
      const entry = { offset: line.offset, nextOffset: line.nextOffset, omission: selected.omission,
        record: selected.record ? this.privacy.apply(selected.record) : null }
      const size = Buffer.byteLength(JSON.stringify(entry))
      requireCodex(size <= byteLimit, 'codex_projected_record_too_large')
      if (entries.length >= limit || bytes + size > byteLimit) break
      entries.push(entry); bytes += size; nextOffset = line.nextOffset
    }
    await source.recheck()
    const nextCursor: CodexHistoryCursor | null = nextOffset < this.throughOffset ? {
      sourceKey: key, resourceRevision: source.resourceRevision,
      capturedBytes: source.capturedBytes, offset: nextOffset,
    } : null
    requireCodex(!nextCursor || nextOffset > start, 'codex_cursor_not_advancing')
    return { source: source.identity, watermark: source.resourceRevision, capturedBytes: source.capturedBytes,
      throughOffset: this.throughOffset, entries, nextCursor,
      completeness: this.throughOffset < source.capturedBytes ? 'partial-final-record' as const
        : this.unsupportedRecords > 0 ? 'unsupported-records' as const : 'complete-supported-prefix' as const,
      unsupportedRecords: this.unsupportedRecords, control: 'unavailable' as const }
  }
}
