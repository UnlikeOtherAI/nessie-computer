import { requireCapture } from '../state/sqlite.js'
import type { CaptureDatabase, SqlRow, SqlStatement, SqlValue } from '../state/sqlite.js'
import { tablesForLayout, selectCaptureRows, legacyThreads, legacyMessages, legacyPullRequests } from '../import/layout.js'

export type SourceExchange = (request: Record<string, unknown>) => Record<string, unknown>

/** The receiver accepts named reads only. It never accepts caller SQL. */
export function heldSourceDatabase(exchange: SourceExchange, layout: 'v2-80' | 'legacy-54'): CaptureDatabase {
  const tables = tablesForLayout(layout)
  const query = (sql: string, parameters: SqlValue[]): Record<string, unknown> => {
    const fixed = new Map([
      ['SELECT schema_version FROM pragma_schema_version', 'schemaVersion'],
      ["SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'", 'migrationTable'],
      ['SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id', 'migrations'],
      ['SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events', 'highWater'],
    ])
    const name = fixed.get(sql)
    if (name) {
      requireCapture(parameters.length === 0, 'source_query_not_admitted')
      return { query: name }
    }
    const table = tables.find(entry => selectCaptureRows(entry) === sql)
    if (table) {
      requireCapture(parameters.length === 0, 'source_query_not_admitted')
      return { query: 'rows', table: table.name }
    }
    const baseline = [legacyThreads, legacyMessages, legacyPullRequests].find(entry => selectCaptureRows(entry) === sql)
    if (layout === 'v2-80' && baseline) {
      requireCapture(parameters.length === 0, 'source_query_not_admitted')
      return { query: 'frozenLegacy', table: baseline.name }
    }
    requireCapture(parameters.length === 1 && tables.some(entry => entry.name === parameters[0]),
      'source_query_not_admitted')
    requireCapture(sql === 'SELECT type, sql FROM sqlite_schema WHERE name = ?'
      || sql === 'SELECT name FROM pragma_table_info(?)', 'source_query_not_admitted')
    return { query: sql.startsWith('SELECT type') ? 'tableSchema' : 'columns', table: parameters[0] }
  }
  return {
    exec(sql) {
      requireCapture(['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql), 'source_write_refused')
      exchange({ op: 'transaction', action: sql })
    },
    prepare(sql): SqlStatement {
      const iterate = function* (...parameters: SqlValue[]): IterableIterator<SqlRow> {
        const { statement } = exchange({ op: 'query', ...query(sql, parameters) })
        requireCapture(typeof statement === 'number', 'source_protocol_invalid')
        try {
          for (;;) {
            const response = exchange({ op: 'next', statement })
            if (response.done === true) return
            requireCapture(response.row && typeof response.row === 'object' && !Array.isArray(response.row),
              'source_protocol_invalid')
            yield response.row as SqlRow
          }
        } finally { exchange({ op: 'finalize', statement }) }
      }
      return {
        iterate,
        all: (...parameters) => [...iterate(...parameters)],
        get: (...parameters) => {
          const rows = iterate(...parameters)
          try { return rows.next().value as SqlRow | undefined } finally { rows.return?.() }
        },
        run: () => { throw new Error('source_write_refused') },
      }
    },
  }
}
