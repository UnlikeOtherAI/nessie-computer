import { journalTransaction, requireCapture } from './sqlite.js'
import type { CaptureDatabase, SqlRow } from './sqlite.js'
import type { ProvenT3Source } from '../import/manifest.js'
import type { NativeHistoryAlias } from '../ownership/continuity.js'

export interface CapturedIdentity {
  readonly threadId: string
  readonly state: 'active' | 'archived' | 'deleted'
}

/** Executor-owned local metadata only. The caller supplies its owned durable
 * SQLite handle; no source handle, private Prisma model or server claim belongs here.
 */
export class T3CaptureJournal {
  private readonly database: CaptureDatabase
  constructor(ownedDatabase: CaptureDatabase) {
    this.database = ownedDatabase
    ownedDatabase.exec(`
      CREATE TABLE IF NOT EXISTS t3_capture_roots (
        physical_root TEXT PRIMARY KEY, environment_id TEXT NOT NULL,
        conflict INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
        generation TEXT, catalog_generation TEXT, hydrated_generation TEXT, last_ready_generation TEXT
      );
      CREATE TABLE IF NOT EXISTS t3_capture_root_aliases (
        admitted_root TEXT PRIMARY KEY, physical_root TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS t3_capture_generations (
        generation TEXT PRIMARY KEY, physical_root TEXT NOT NULL, stage_ref TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL, source_high_water INTEGER, failure_code TEXT
      );
      CREATE TABLE IF NOT EXISTS t3_capture_catalog (
        physical_root TEXT NOT NULL, thread_id TEXT NOT NULL, source_state TEXT NOT NULL,
        seen_generation TEXT NOT NULL, PRIMARY KEY (physical_root, thread_id)
      );
      CREATE TABLE IF NOT EXISTS t3_capture_native_aliases (
        physical_root TEXT NOT NULL, thread_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
        driver TEXT NOT NULL, native_id TEXT NOT NULL, strength TEXT NOT NULL,
        continuation_home TEXT NOT NULL, history_home TEXT NOT NULL, home_proof TEXT NOT NULL,
        PRIMARY KEY (physical_root, thread_id, provider_thread_id, driver, native_id, continuation_home, history_home)
      );
    `)
  }

  begin(source: ProvenT3Source, generation: string, stageReference: string): void {
    const conflict = journalTransaction(this.database, () => {
      const alias = this.database.prepare('SELECT physical_root FROM t3_capture_root_aliases WHERE admitted_root = ?')
        .get(source.admittedRootKey)
      requireCapture(!alias || alias.physical_root === source.physicalRootKey, 'source_alias_rebinding')
      const root = this.root(source.physicalRootKey)
      requireCapture(!root || root.environment_id === source.environmentId, 'source_root_rebinding')
      this.database.prepare('INSERT OR IGNORE INTO t3_capture_roots (physical_root, environment_id) VALUES (?, ?)')
        .run(source.physicalRootKey, source.environmentId)
      this.database.prepare('INSERT OR IGNORE INTO t3_capture_root_aliases (admitted_root, physical_root) VALUES (?, ?)')
        .run(source.admittedRootKey, source.physicalRootKey)
      const candidates = this.database.prepare('SELECT physical_root FROM t3_capture_roots WHERE environment_id = ?')
        .all(source.environmentId)
      if (candidates.length > 1) {
        this.database.prepare('UPDATE t3_capture_roots SET conflict = 1 WHERE environment_id = ?').run(source.environmentId)
      }
      if (this.root(source.physicalRootKey)?.conflict === 1) return true
      requireCapture(!this.database.prepare('SELECT generation FROM t3_capture_generations WHERE generation = ?').get(generation),
        'capture_generation_reuse')
      this.database.prepare(`INSERT INTO t3_capture_generations
        (generation, physical_root, stage_ref, phase) VALUES (?, ?, ?, 'capturing')`)
        .run(generation, source.physicalRootKey, stageReference)
      this.database.prepare(`UPDATE t3_capture_roots SET generation = ?, catalog_generation = NULL,
        hydrated_generation = NULL, available = 1 WHERE physical_root = ?`).run(generation, source.physicalRootKey)
      return false
    })
    // Conflict evidence must commit even though import is refused.
    requireCapture(!conflict, 'divergent_physical_source_roots')
  }

  markCaptured(source: ProvenT3Source, generation: string, sourceHighWater: number): void {
    journalTransaction(this.database, () => {
      this.requireCurrent(source.physicalRootKey, generation)
      this.database.prepare(`UPDATE t3_capture_generations SET phase = 'captured', source_high_water = ?
        WHERE generation = ? AND phase = 'capturing'`).run(sourceHighWater, generation)
      requireCapture(this.generation(generation)?.phase === 'captured', 'capture_phase_mismatch')
    })
  }

  recover(source: ProvenT3Source, generation: string): void {
    journalTransaction(this.database, () => {
      const root = this.root(source.physicalRootKey)
      const job = this.generation(generation)
      requireCapture(root?.environment_id === source.environmentId && root?.conflict === 0 && root.generation === generation &&
        job?.physical_root === source.physicalRootKey && (job.phase === 'captured' || job.phase === 'ready'),
      'capture_not_resumable')
      this.database.prepare('UPDATE t3_capture_roots SET available = 1 WHERE physical_root = ?').run(source.physicalRootKey)
    })
  }

  /** Call only after the actual original importer has no pending transcripts.
   * Root advancement, alias conflicts and publication recheck share this write lock.
   */
  complete(source: ProvenT3Source, generation: string, identities: readonly CapturedIdentity[],
    aliases: readonly NativeHistoryAlias[]): void {
    journalTransaction(this.database, () => {
      this.requireCurrent(source.physicalRootKey, generation)
      const phase = this.generation(generation)?.phase
      requireCapture(phase === 'captured' || phase === 'ready', 'capture_not_consistent')
      for (const identity of identities) {
        this.database.prepare(`INSERT INTO t3_capture_catalog (physical_root, thread_id, source_state, seen_generation)
          VALUES (?, ?, ?, ?) ON CONFLICT (physical_root, thread_id) DO UPDATE SET
          source_state = CASE WHEN source_state = 'deleted' THEN 'deleted' ELSE excluded.source_state END,
          seen_generation = excluded.seen_generation`)
          .run(source.physicalRootKey, identity.threadId, identity.state, generation)
      }
      for (const alias of aliases) {
        requireCapture(identities.some(identity => identity.threadId === alias.threadId), 'alias_without_app_identity')
        this.database.prepare(`INSERT OR IGNORE INTO t3_capture_native_aliases
          (physical_root, thread_id, provider_thread_id, driver, native_id, strength, continuation_home, history_home, home_proof)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(source.physicalRootKey, alias.threadId, alias.providerThreadId, alias.driver, alias.nativeId, alias.strength,
            alias.continuationHomeKey, alias.historyHomeKey, alias.homeProofReference)
      }
      this.database.prepare(`UPDATE t3_capture_generations SET phase = 'ready', failure_code = NULL WHERE generation = ?`)
        .run(generation)
      this.database.prepare(`UPDATE t3_capture_roots SET catalog_generation = ?, hydrated_generation = ?,
        last_ready_generation = ? WHERE physical_root = ?`).run(generation, generation, generation, source.physicalRootKey)
    })
  }

  fail(source: ProvenT3Source, generation: string, code: string): void {
    journalTransaction(this.database, () => {
      this.database.prepare('UPDATE t3_capture_generations SET failure_code = ? WHERE generation = ?')
        .run(code, generation)
      // A failed obsolete job cannot mark a newer successful capture unavailable.
      this.database.prepare('UPDATE t3_capture_roots SET available = 0 WHERE physical_root = ? AND generation = ?')
        .run(source.physicalRootKey, generation)
    })
  }

  unavailable(admittedRootKey: string): void {
    this.database.prepare(`UPDATE t3_capture_roots SET available = 0 WHERE physical_root IN
      (SELECT physical_root FROM t3_capture_root_aliases WHERE admitted_root = ?)`).run(admittedRootKey)
  }

  requireCurrent(physicalRootKey: string, generation: string): void {
    const root = this.root(physicalRootKey)
    requireCapture(root && root.conflict === 0 && root.available === 1 && root.generation === generation,
      'capture_generation_unavailable_or_obsolete')
  }

  root(physicalRootKey: string): SqlRow | undefined {
    return this.database.prepare('SELECT * FROM t3_capture_roots WHERE physical_root = ?').get(physicalRootKey)
  }

  generation(generation: string): SqlRow | undefined {
    return this.database.prepare('SELECT * FROM t3_capture_generations WHERE generation = ?').get(generation)
  }

  catalog(physicalRootKey: string): readonly SqlRow[] {
    return this.database.prepare('SELECT * FROM t3_capture_catalog WHERE physical_root = ? ORDER BY thread_id').all(physicalRootKey)
  }
}
