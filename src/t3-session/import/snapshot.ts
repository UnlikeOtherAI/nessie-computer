import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { AdmittedT3SourcePort, T3SourceManifest } from './manifest.js'
import { tablesForLayout } from './layout.js'
import { withSourceSnapshotView, type T3SourceSnapshot } from './snapshot-view.js'
export type { T3SourceSnapshot } from './snapshot-view.js'
import type { RetainedOriginalOwnerPort, RetainedReadScope } from '../ownership/continuity.js'
import { withRetainedReadScope } from '../ownership/continuity.js'
import type { RetainedImportAuthorityPort } from '../ownership/import-scope.js'
import { checkT3SourceLayout } from '../source/layout-check.js'
export { checkT3SourceLayout } from '../source/layout-check.js'

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
        const result = await withSourceSnapshotView(database, source, sourceHighWater,
          () => requireCapture(transaction, 'source_snapshot_closed_or_table_not_admitted'),
          snapshot => use(snapshot, reads))
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
