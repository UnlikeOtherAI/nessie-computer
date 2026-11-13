import { requireCapture, type CaptureDatabase } from '../state/sqlite.js'
import type { ProvenT3Source } from '../import/manifest.js'
import type { CaptureTable } from '../import/layout.js'
import migrationManifest from '../import/migration-manifest.json' with { type: 'json' }

/** Shared physical schema check. No retained-human or execution authority is issued. */
export function checkT3SourceLayout(
  database: CaptureDatabase, source: ProvenT3Source, tables: readonly CaptureTable[],
): void {
  requireCapture(source.layout === 'v2-80' || source.layout === 'legacy-54', 'unsupported_source_layout')
  const head = source.layout === 'v2-80' ? 80 : 54
  requireCapture(source.databaseRole === (head === 80 ? 'authoritative-v2' : 'sole-legacy'), 'source_role_mismatch')
  requireCapture(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'")
    .get(), 'unsupported_source_migration')
  const migrations = database.prepare('SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id').all()
  requireCapture(migrations.length === head, 'unsupported_source_migration')
  for (const [index, row] of migrations.entries()) {
    const expected = migrationManifest[index]
    requireCapture(expected && row.migration_id === expected[0] && row.name === expected[1], 'unsupported_source_migration')
  }
  for (const entry of tables) {
    const schema = database.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?').get(entry.name)
    requireCapture(schema?.type === 'table' && typeof schema.sql === 'string' &&
      /^CREATE TABLE\s/iu.test(schema.sql), 'unsupported_source_table')
    const columns = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all(entry.name).map(row => row.name))
    requireCapture(entry.columns.every(column => columns.has(column)), 'unsupported_source_columns')
  }
}
