import { createHmac } from 'node:crypto'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { CaptureDatabase, SqlRow } from '../state/sqlite.js'
import type { AdmittedT3SourcePort, ProvenT3Source, T3SourceManifest } from './manifest.js'
import { tablesForLayout, selectCaptureRows, legacyThreads, legacyMessages, legacyPullRequests } from './layout.js'
import type { CaptureTable } from './layout.js'
import type { RetainedOriginalOwnerPort, RetainedReadScope } from '../ownership/continuity.js'
import { withRetainedReadScope } from '../ownership/continuity.js'
import type { RetainedImportAuthorityPort } from '../ownership/import-scope.js'
import migrationManifest from './migration-manifest.json' with { type: 'json' }

export interface T3SourceSnapshot {
  readonly source: ProvenT3Source
  readonly sourceHighWater: number
  readonly tables: readonly CaptureTable[]
  rows(table: CaptureTable): Iterable<SqlRow>
  fingerprint(key: string): { digest: string; legacyDigest: string }
}

export function checkT3SourceLayout(database: CaptureDatabase, source: ProvenT3Source, tables: readonly CaptureTable[]): void {
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
    const schema = database.prepare("SELECT type, sql FROM sqlite_schema WHERE name = ?").get(entry.name)
    requireCapture(schema?.type === 'table' && typeof schema.sql === 'string' &&
      /^CREATE TABLE\s/iu.test(schema.sql), 'unsupported_source_table')
    const columns = new Set(database.prepare('SELECT name FROM pragma_table_info(?)').all(entry.name).map(row => row.name))
    requireCapture(entry.columns.every(column => columns.has(column)), 'unsupported_source_columns')
  }
}

/** A supported read transaction pins WAL-visible schema and rows. No migrations,
 * checkpoint, immutable URI, write pragma, source copy or auxiliary file read.
 * The resource producer must open readOnly:true, retain the physical lease and
 * refuse replacement through both rechecks. Windows source implementation still
 * requires native/installed qualification; historical-human admission is unbound.
 */
export async function withT3SourceSnapshot<A>(
  port: AdmittedT3SourcePort | undefined,
  manifest: T3SourceManifest,
  admittedRootKey: string,
  owner: RetainedOriginalOwnerPort | RetainedImportAuthorityPort | undefined,
  generation: string,
  use: (snapshot: T3SourceSnapshot, reads: RetainedReadScope) => Promise<A>,
  afterCommit?: (value: A, reads: RetainedReadScope, recheckPhysicalSource: () => Promise<void>) => Promise<void>,
): Promise<A> {
  requireCapture(port && typeof port.withReadonlySource === 'function', 'required_admitted_local_source_port')
  requireCapture(owner && typeof owner.withReadScope === 'function', 'required_original_owner_continuity_port')
  requireCapture(manifest.homes.some(home => home.admittedRootKey === admittedRootKey), 'source_not_in_manifest')
  requireCapture(new Set(manifest.homes.map(home => home.admittedRootKey)).size === manifest.homes.length,
    'duplicate_manifest_admission')
  return port.withReadonlySource(manifest, admittedRootKey, async (source, database, recheck) => {
    requireCapture(source.admittedRootKey === admittedRootKey, 'source_admission_mismatch')
    return withRetainedReadScope(owner, { source, physicalSourceRecheck: recheck,
      captureGeneration: generation }, async reads => {
      const tables = tablesForLayout(source.layout)
      let transaction = false
      try {
        database.exec('BEGIN')
        transaction = true
        // First read establishes the snapshot before the physical identity recheck.
        database.prepare('SELECT schema_version FROM pragma_schema_version').get()
        await recheck()
        await reads.recheckSource()
        checkT3SourceLayout(database, source, tables)
        const sourceHighWater = source.layout === 'v2-80'
          ? database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events').get()?.sequence : 0
        requireCapture(typeof sourceHighWater === 'number' && Number.isSafeInteger(sourceHighWater) && sourceHighWater >= 0,
          'invalid_source_sequence')
        const fingerprint = (entries: readonly CaptureTable[], key: string, sequence: number) => {
          requireCapture(transaction, 'source_snapshot_closed_or_table_not_admitted')
          const hash = createHmac('sha256', key)
          hash.update(JSON.stringify(['t3-capture-snapshot-v1', source.layout, sequence]))
          for (const entry of entries) {
            hash.update(JSON.stringify([entry.name, entry.columns]))
            for (const row of database.prepare(selectCaptureRows(entry)).iterate()) {
              hash.update(JSON.stringify(entry.columns.map(column => row[column])))
              hash.update('\n')
            }
          }
          return hash.digest('hex')
        }
        const snapshot: T3SourceSnapshot = { source, sourceHighWater, tables,
          fingerprint: key => ({ digest: fingerprint(tables, key, sourceHighWater),
            legacyDigest: fingerprint([legacyThreads, legacyMessages, legacyPullRequests], key, 0) }),
          rows: function* (entry) {
            requireCapture(transaction && tables.includes(entry), 'source_snapshot_closed_or_table_not_admitted')
            const iterator = database.prepare(selectCaptureRows(entry)).iterate()
            try {
              for (;;) {
                requireCapture(transaction, 'source_snapshot_closed_or_table_not_admitted')
                const next = iterator.next()
                if (next.done) return
                yield next.value
              }
            } finally { iterator.return?.() }
          } }
        const result = await use(snapshot, reads)
        await recheck()
        await reads.recheckSource()
        database.exec('COMMIT')
        transaction = false
        await afterCommit?.(result, reads, recheck)
        await recheck()
        await reads.recheckSource()
        return result
      } catch (error) {
        if (transaction) {
          try { database.exec('ROLLBACK') } catch { /* Retain the original failure; the port must close this handle. */ }
        }
        if (error instanceof CaptureFailure) throw error
        // Never retain driver diagnostics containing paths, SQL values or transcript bodies.
        throw new CaptureFailure('source_capture_unavailable_or_invalid')
      }
    })
  })
}
