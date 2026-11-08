import { codexIdentity, requireCodex, type CodexHomeIdentity, type CodexNativeIdentity } from './identity.js'

/** Deliberately no open/exec/run interface. The shared producer owns the held readonly transaction. */
export interface CodexIndexDatabase {
  prepare(sql: string): { all(...parameters: (string | number)[]): Record<string, unknown>[] }
}

export interface CodexIndexEntry {
  readonly identity: CodexNativeIdentity
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly state: 'active' | 'archived'
  /** Internal lookup hint only. It is neither a resource grant nor a wire result. */
  readonly rolloutPath: string
}

export interface CodexIndexCursor {
  readonly sourceKey: string
  readonly watermark: string
  readonly updatedAt: number
  readonly nativeId: string
}

const columns = ['id', 'title', 'created_at', 'updated_at', 'archived', 'rollout_path'] as const
const sourceKey = (home: CodexHomeIdentity) => JSON.stringify([
  'codex', home.executorId, home.continuationHomeKey, home.historyHomeKey,
])

/** Complete state-index paging, including empty and archived threads and arbitrarily old dates.
 * This alone is NOT complete native inventory: unindexed active/archive rollouts must join it.
 * All columns are explicit; tokens, accounts, credentials and provider configuration are not read.
 */
export function readCodexIndexPage(database: CodexIndexDatabase, home: CodexHomeIdentity, watermark: string,
  input: { readonly limit?: number; readonly cursor?: CodexIndexCursor } = {}) {
  const limit = input.limit ?? 64
  requireCodex(Number.isSafeInteger(limit) && limit >= 1 && limit <= 256, 'codex_page_limit_invalid')
  requireCodex(typeof watermark === 'string' && watermark.length > 0, 'codex_watermark_required')
  const key = sourceKey(home)
  const cursor = input.cursor
  if (cursor) requireCodex(cursor.sourceKey === key && cursor.watermark === watermark &&
    Number.isSafeInteger(cursor.updatedAt) && typeof cursor.nativeId === 'string' && cursor.nativeId.length > 0,
  'codex_cursor_stale')
  const schema = database.prepare('PRAGMA table_info(threads)').all()
  const table = database.prepare("SELECT type FROM sqlite_schema WHERE name = 'threads'").all()
  requireCodex(table.length === 1 && table[0]?.type === 'table', 'codex_index_schema_unsupported')
  requireCodex(columns.every(column => schema.some(field => field.name === column)), 'codex_index_schema_unsupported')
  const rows = database.prepare(`SELECT ${columns.join(', ')} FROM threads${cursor
    ? ' WHERE updated_at < ? OR (updated_at = ? AND id < ?)' : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.nativeId, limit + 1] : [limit + 1]))
  const entries = rows.slice(0, limit).map(row => {
    requireCodex(typeof row.id === 'string' && typeof row.title === 'string' &&
      Buffer.byteLength(row.title) <= 16_384 &&
      Number.isSafeInteger(row.created_at) && Number.isSafeInteger(row.updated_at) &&
      (row.archived === 0 || row.archived === 1) && typeof row.rollout_path === 'string',
    'codex_index_record_unsupported')
    return { identity: codexIdentity(home, row.id), title: row.title,
      createdAt: row.created_at as number, updatedAt: row.updated_at as number,
      state: row.archived === 1 ? 'archived' as const : 'active' as const, rolloutPath: row.rollout_path }
  })
  const last = entries.at(-1)
  const nextCursor: CodexIndexCursor | null = rows.length > limit && last ? {
    sourceKey: key, watermark, updatedAt: last.updatedAt, nativeId: last.identity.nativeId,
  } : null
  return { entries, watermark, nextCursor, indexComplete: nextCursor === null, inventoryComplete: false as const }
}
