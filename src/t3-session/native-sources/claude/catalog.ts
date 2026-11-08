import { nativeIdIsValid } from '../../../existing-session/types.js'
import type { HeldNativeHistoryRoot } from '../held-history.js'
import { digest } from './identity.js'

export interface ClaudeHistoryEntry {
  readonly source: 'claude'
  readonly nativeId: string
  readonly agentId: string | null
  readonly entryKey: string
  readonly historyKey: string
  readonly parentHistoryKey: string | null
  readonly revision: string
  readonly updatedAt: string
}
export interface ClaudeCatalog {
  readonly entries: readonly ClaudeHistoryEntry[]
  readonly generation: string
  readonly complete: boolean
  readonly reasons: readonly string[]
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/** Decode ONLY native layout structure. Neither titles nor record contents are
 * ownership proof. The protected owner has already confined these names. */
function identity(name: string): { nativeId: string; agentId: string | null; parentHistoryKey: string | null } | undefined {
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return undefined
  if (parts.length === 2 && parts[1]!.endsWith('.jsonl') && nativeIdIsValid(parts[1]!.slice(0, -6))) {
    return { nativeId: parts[1]!.slice(0, -6), agentId: null, parentHistoryKey: null }
  }
  if (parts.length === 4 && nativeIdIsValid(parts[1]) && parts[2] === 'subagents'
    && /^agent-[A-Za-z0-9_-]+\.jsonl$/u.test(parts[3]!)) {
    return { nativeId: parts[1], agentId: parts[3]!.slice(6, -6), parentHistoryKey: `${parts[0]}/${parts[1]}.jsonl` }
  }
  return undefined
}

/** All metadata arrives through a held native enumeration capability. This code
 * never accepts a filesystem root path and never searches provider credentials. */
export async function scanClaudeCatalog(root: HeldNativeHistoryRoot, recheck: () => Promise<void>): Promise<ClaudeCatalog> {
  if (root.source !== 'claude' || !root.generation) throw new Error('claude_history_resource_mismatch')
  const entries: ClaudeHistoryEntry[] = []
  const reasons = new Set<string>()
  const seen = new Set<string>()
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let complete = false
  do {
    await recheck()
    await root.recheck()
    const page = await root.enumerate({ ...(cursor ? { cursor } : {}), limit: 200 })
    if (page.generation !== root.generation || page.entries.length > 200
      || (page.complete && page.nextCursor !== null)) throw new Error('claude_catalog_changed')
    for (const entry of page.entries) {
      if (!entry.entryKey || seen.has(entry.entryKey)) throw new Error('claude_catalog_entry_conflict')
      seen.add(entry.entryKey)
      if (entry.kind === 'directory') continue
      if (names.has(entry.relativeName)) throw new Error('claude_catalog_entry_conflict')
      names.add(entry.relativeName)
      const parsed = entry.kind === 'file' ? identity(entry.relativeName) : undefined
      if (!parsed || !entry.revision || !Number.isSafeInteger(entry.size) || entry.size < 0
        || !Number.isFinite(Date.parse(entry.modifiedAt))) {
        reasons.add('unsupported_history_entry'); continue
      }
      entries.push({ source: 'claude', ...parsed, entryKey: entry.entryKey, historyKey: entry.relativeName,
        revision: entry.revision, updatedAt: new Date(Date.parse(entry.modifiedAt)).toISOString() })
    }
    // Native reasons are diagnostic enums, not unchecked path/error text.
    if (page.reasons.length) reasons.add('native_history_enumeration_incomplete')
    if (page.nextCursor !== null && (!page.nextCursor || cursors.has(page.nextCursor))) {
      throw new Error('claude_catalog_cursor_invalid')
    }
    if (page.nextCursor === null) {
      complete = page.complete
      if (!complete) reasons.add('native_history_enumeration_incomplete')
    } else cursors.add(page.nextCursor)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  await root.recheck()
  await recheck()
  entries.sort((a, b) => compare(b.updatedAt, a.updatedAt) || compare(a.historyKey, b.historyKey))
  const orderedReasons = [...reasons].sort()
  return { entries, generation: digest([root.generation, entries, orderedReasons]),
    complete: complete && !reasons.size, reasons: orderedReasons }
}
