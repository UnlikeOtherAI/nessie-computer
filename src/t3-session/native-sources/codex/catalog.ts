import { codexIdentity, codexIdentityKey, requireCodex } from './identity.js'
import type { CodexHomeIdentity, CodexNativeIdentity } from './identity.js'

export type CodexInventoryPart = 'state-index' | 'sessions' | 'archived-sessions'
export interface CodexCatalogRow {
  readonly identity: CodexNativeIdentity
  readonly title: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly state: 'active' | 'archived' | 'deleted'
  /** Opaque held-resource references, never rollout paths or account/profile identities. */
  readonly historyReferences: readonly string[]
}
export interface CodexCatalogCursor {
  readonly sourceKey: string
  readonly watermark: string
  readonly offset: number
}

const parts: readonly CodexInventoryPart[] = ['state-index', 'sessions', 'archived-sessions']

/** Capture-local reconciliation. The producer enumerates the whole admitted native home:
 * state-only/empty threads plus both rollout trees. This class never treats a recent search,
 * absent row or interrupted scanner as a tombstone or a complete inventory.
 */
export class CodexRetainedCatalog {
  private readonly rows = new Map<string, CodexCatalogRow>()
  private readonly indexKeys = new Set<string>()
  private readonly progress = new Map<CodexInventoryPart, {
    cursor: string | null; seen: Set<string>; complete: boolean
  }>()
  private sealed: readonly CodexCatalogRow[] | undefined
  readonly watermark: string
  private readonly maximumRows: number
  private readonly home: CodexHomeIdentity
  private readonly sourceKey: string

  constructor(home: CodexHomeIdentity, watermark: string, maximumRows = 100_000) {
    requireCodex(watermark.length > 0 && watermark.length <= 4096 && Number.isSafeInteger(maximumRows) &&
      maximumRows > 0 && maximumRows <= 1_000_000, 'codex_capture_invalid')
    this.home = Object.freeze({ ...home }); this.watermark = watermark; this.maximumRows = maximumRows
    this.sourceKey = JSON.stringify(['codex', home.executorId, home.continuationHomeKey, home.historyHomeKey])
  }

  append(part: CodexInventoryPart, page: { readonly watermark: string; readonly cursor: string | null;
    readonly nextCursor: string | null; readonly rows: readonly CodexCatalogRow[] }): void {
    requireCodex(!this.sealed && parts.includes(part) && page.watermark === this.watermark && page.rows.length <= 256,
      'codex_inventory_page_invalid')
    const progress = this.progress.get(part) ?? { cursor: null, seen: new Set<string>(), complete: false }
    requireCodex(!progress.complete && page.cursor === progress.cursor, 'codex_inventory_cursor_stale')
    requireCodex(page.nextCursor === null || (page.nextCursor.length > 0 && page.nextCursor.length <= 4096 &&
      page.nextCursor !== page.cursor && !progress.seen.has(page.nextCursor)), 'codex_inventory_cursor_not_advancing')
    // Validate the entire page before mutating capture-local state.
    const staged = new Map<string, CodexCatalogRow>()
    for (const row of page.rows) {
      requireCodex(row.identity.source === 'codex' && Number.isSafeInteger(row.createdAt) &&
        Number.isSafeInteger(row.updatedAt) && (row.title === null ||
          (typeof row.title === 'string' && Buffer.byteLength(row.title) <= 16_384)) &&
        ['active', 'archived', 'deleted'].includes(row.state) && row.historyReferences.length <= 64 &&
        row.historyReferences.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 4096),
      'codex_inventory_record_invalid')
      const key = codexIdentityKey(row.identity)
      requireCodex(key === codexIdentityKey(codexIdentity(this.home, row.identity.nativeId)),
        'codex_inventory_source_mismatch')
      const old = staged.get(key) ?? this.rows.get(key)
      const indexed = this.indexKeys.has(key)
      requireCodex(!old || old.state !== 'deleted' || row.state === 'deleted', 'codex_tombstone_revival')
      // State-index metadata wins over directory observations; directory movement is not deletion.
      // Distinct history resources are retained even when account overlays share a native home.
      const selected = indexed && part !== 'state-index' && row.state !== 'deleted' ? old! : row
      const historyReferences = [...new Set([...(old?.historyReferences ?? []), ...row.historyReferences])]
      requireCodex(historyReferences.length <= 64, 'codex_history_reference_capacity')
      staged.set(key, Object.freeze({ ...selected, identity: Object.freeze({ ...selected.identity }),
        historyReferences: Object.freeze(historyReferences) }))
    }
    const additions = [...staged.keys()].filter(key => !this.rows.has(key)).length
    requireCodex(this.rows.size + additions <= this.maximumRows, 'codex_catalog_capacity')
    for (const [key, row] of staged) {
      this.rows.set(key, row)
      if (part === 'state-index') this.indexKeys.add(key)
    }
    if (page.nextCursor) progress.seen.add(page.nextCursor)
    progress.cursor = page.nextCursor
    progress.complete = page.nextCursor === null
    this.progress.set(part, progress)
  }

  /** Only call after all held-resource and original-human checks pass at publication.
   * Sealing supplies data completeness, not a server publication/admission receipt.
   */
  seal(): void {
    requireCodex(!this.sealed && parts.every(part => this.progress.get(part)?.complete), 'codex_inventory_incomplete')
    this.sealed = Object.freeze([...this.rows.values()].sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      Buffer.compare(Buffer.from(right.identity.nativeId), Buffer.from(left.identity.nativeId)) ||
      Buffer.compare(Buffer.from(codexIdentityKey(left.identity)), Buffer.from(codexIdentityKey(right.identity)))))
  }

  page(input: { readonly cursor?: CodexCatalogCursor; readonly limit?: number; readonly byteLimit?: number } = {}) {
    requireCodex(this.sealed, 'codex_inventory_incomplete')
    const limit = input.limit ?? 64
    const byteLimit = input.byteLimit ?? 512 * 1024
    const offset = input.cursor?.offset ?? 0
    requireCodex(Number.isSafeInteger(limit) && limit >= 1 && limit <= 256 && Number.isSafeInteger(byteLimit) &&
      byteLimit >= 64 * 1024 && byteLimit <= 1024 * 1024 && Number.isSafeInteger(offset) &&
      offset >= 0 && offset <= this.sealed.length && (!input.cursor || (input.cursor.watermark === this.watermark &&
        input.cursor.sourceKey === this.sourceKey)),
    'codex_catalog_cursor_stale')
    const rows: CodexCatalogRow[] = []
    let bytes = 0
    for (const row of this.sealed.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(row))
      requireCodex(size <= byteLimit, 'codex_catalog_record_too_large')
      if (bytes + size > byteLimit) break
      rows.push(row); bytes += size
    }
    const next = offset + rows.length
    return { source: 'codex' as const, watermark: this.watermark, rows,
      nextCursor: next < this.sealed.length
        ? { sourceKey: this.sourceKey, watermark: this.watermark, offset: next } : null,
      inventoryComplete: true as const, control: 'unavailable' as const }
  }
}
