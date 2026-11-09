import { scanClaudeCatalog, type ClaudeHistoryEntry } from './catalog.js'
import type { HeldNativeHistoryRoot } from '../held-history.js'
import { digest } from './identity.js'
import { readClaudeHistoryPage } from './history.js'

export interface ClaudeReadTarget {
  readonly source: 'claude'
  readonly admittedRootKey: string
  readonly historyId?: string
}
export interface ClaudeReadLease {
  readonly source: 'claude'
  readonly admittedRootKey: string
  readonly physicalRootKey: string
  /** Issued by the protected native owner, never constructed from a root path. */
  readonly historyRoot: HeldNativeHistoryRoot
  /** Canonical producer checks current human/team/executor/source admission,
   * root identity and revocation; freshness <=60s. No execution permission. */
  recheck(): Promise<void>
  /** Check the exact discovered native identity, before its bytes are opened.
   * Root discovery permission alone must not authorize every transcript. */
  recheckHistory(identity: {
    readonly historyId: string; readonly nativeId: string; readonly agentId: string | null
  }): Promise<void>
}

/** REQUIRED, UNBOUND canonical admission producer. No callback factory here
 * turns a path, current login, profile, heartbeat or managed launch into a grant. */
export interface ClaudeHistoryReadPort {
  withReadScope<A>(target: ClaudeReadTarget, use: (lease: ClaudeReadLease) => Promise<A>): Promise<A>
}
export interface ClaudeCatalogCursor { readonly generation: string; readonly offset: number }
export interface ClaudeHistoryCursor { readonly historyId: string; readonly revision: string; readonly offset: number }
const historyIdOf = (lease: ClaudeReadLease, entry: ClaudeHistoryEntry): string =>
  digest(['claude', lease.physicalRootKey, entry.historyKey])

/** Canonical finite read operations for the future UI/WebMCP/MCP bindings.
 * These never launch Claude, resume a provider or register another writer. */
export class NativeClaudeHistory {
  private readonly admission: ClaudeHistoryReadPort | undefined
  constructor(admission?: ClaudeHistoryReadPort) { this.admission = admission }

  private async withScope<A>(target: ClaudeReadTarget, use: (lease: ClaudeReadLease) => Promise<A>): Promise<A> {
    if (!this.admission) throw new Error('claude_history_admission_required_unbound')
    if (target.source !== 'claude' || !target.admittedRootKey) throw new Error('claude_history_target_invalid')
    return this.admission.withReadScope(target, async lease => {
      if (lease.source !== 'claude' || lease.admittedRootKey !== target.admittedRootKey || !lease.physicalRootKey
        || lease.historyRoot?.source !== 'claude' || lease.historyRoot.admittedRootKey !== target.admittedRootKey
        || lease.historyRoot.physicalRootKey !== lease.physicalRootKey) {
        throw new Error('claude_history_admission_mismatch')
      }
      await lease.recheck()
      await lease.historyRoot.recheck()
      const result = await use(lease)
      await lease.historyRoot.recheck()
      await lease.recheck()
      return result
    })
  }

  async catalog(input: {
    readonly target: ClaudeReadTarget; readonly cursor?: ClaudeCatalogCursor; readonly limit?: number
  }) {
    const limit = input.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('claude_history_page_invalid')
    return this.withScope(input.target, async lease => {
      const catalog = await scanClaudeCatalog(lease.historyRoot, () => lease.recheck())
      const generation = digest([lease.physicalRootKey, catalog.generation])
      const offset = input.cursor?.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > catalog.entries.length
        || (input.cursor && input.cursor.generation !== generation)) throw new Error('claude_catalog_cursor_stale')
      const rows = []
      for (const entry of catalog.entries.slice(offset, offset + limit)) {
        const historyId = historyIdOf(lease, entry)
        await lease.recheckHistory({ historyId, nativeId: entry.nativeId, agentId: entry.agentId })
        rows.push({ source: 'claude' as const, admittedRootKey: lease.admittedRootKey, historyId,
          nativeId: entry.nativeId, agentId: entry.agentId, updatedAt: entry.updatedAt, revision: entry.revision,
          parentHistoryId: entry.parentHistoryKey === null ? null
            : digest(['claude', lease.physicalRootKey, entry.parentHistoryKey]),
          control: 'unavailable' as const, controlReason: 'native_stop_handoff_unbound' as const })
      }
      await lease.historyRoot.recheck()
      const nextOffset = offset + rows.length
      return { source: 'claude' as const, generation, rows,
        complete: catalog.complete && nextOffset === catalog.entries.length,
        sourceComplete: catalog.complete, reasons: catalog.reasons,
        nextCursor: nextOffset < catalog.entries.length ? { generation, offset: nextOffset } : null }
    })
  }

  async history(input: { readonly target: ClaudeReadTarget & { readonly historyId: string };
    readonly cursor?: ClaudeHistoryCursor; readonly limit?: number }) {
    return this.withScope(input.target, async lease => {
      const catalog = await scanClaudeCatalog(lease.historyRoot, () => lease.recheck())
      const entry = catalog.entries.find(row => historyIdOf(lease, row) === input.target.historyId)
      if (!entry) throw new Error('claude_history_not_found')
      if (input.cursor && (input.cursor.historyId !== input.target.historyId
        || input.cursor.revision !== entry.revision)) {
        throw new Error('claude_history_cursor_stale')
      }
      const recheck = async () => {
        await lease.recheck()
        await lease.recheckHistory({
          historyId: input.target.historyId, nativeId: entry.nativeId, agentId: entry.agentId,
        })
      }
      await recheck()
      const page = await lease.historyRoot.withFile(entry.entryKey, entry.revision, async file => {
        if (file.entryKey !== entry.entryKey) throw new Error('claude_history_resource_mismatch')
        await recheck()
        return readClaudeHistoryPage({ file, nativeId: entry.nativeId, revision: entry.revision,
          offset: input.cursor?.offset ?? 0, limit: input.limit ?? 100, recheck })
      })
      await recheck()
      const { nextOffset, ...result } = page
      return { source: 'claude' as const, historyId: input.target.historyId, ...result,
        nextCursor: nextOffset === null ? null
          : { historyId: input.target.historyId, revision: page.revision, offset: nextOffset } }
    })
  }
}
