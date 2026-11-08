import { randomUUID } from 'node:crypto'
import type { CaptureDatabase } from './sqlite.js'
import { journalTransaction, requireCapture } from './sqlite.js'

export interface CaptureAttempt { readonly id: string }

/** Metadata-only failure observations. Incarnations fence generation/availability
 * ABA, including recovery of the same generation, and alias removal/recreation.
 * These are journal CAS tokens, never resource or human authority.
 */
export class CaptureAttempts {
  private readonly database: CaptureDatabase
  constructor(database: CaptureDatabase) {
    this.database = database
    database.exec(`
      CREATE TABLE IF NOT EXISTS t3_capture_root_versions (
        physical_root TEXT PRIMARY KEY, version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS t3_capture_alias_versions (
        admitted_root TEXT PRIMARY KEY, version TEXT NOT NULL
      );
      INSERT OR IGNORE INTO t3_capture_root_versions SELECT physical_root, hex(randomblob(32)) FROM t3_capture_roots;
      INSERT OR IGNORE INTO t3_capture_alias_versions SELECT admitted_root, hex(randomblob(32)) FROM t3_capture_root_aliases;
      CREATE TRIGGER IF NOT EXISTS t3_capture_root_insert_version AFTER INSERT ON t3_capture_roots BEGIN
        INSERT OR REPLACE INTO t3_capture_root_versions VALUES (NEW.physical_root, hex(randomblob(32)));
      END;
      CREATE TRIGGER IF NOT EXISTS t3_capture_root_update_version AFTER UPDATE ON t3_capture_roots BEGIN
        INSERT OR REPLACE INTO t3_capture_root_versions VALUES (NEW.physical_root, hex(randomblob(32)));
      END;
      CREATE TRIGGER IF NOT EXISTS t3_capture_root_delete_version AFTER DELETE ON t3_capture_roots BEGIN
        DELETE FROM t3_capture_root_versions WHERE physical_root = OLD.physical_root;
      END;
      CREATE TRIGGER IF NOT EXISTS t3_capture_alias_insert_version AFTER INSERT ON t3_capture_root_aliases BEGIN
        INSERT OR REPLACE INTO t3_capture_alias_versions VALUES (NEW.admitted_root, hex(randomblob(32)));
      END;
      CREATE TRIGGER IF NOT EXISTS t3_capture_alias_update_version AFTER UPDATE ON t3_capture_root_aliases BEGIN
        INSERT OR REPLACE INTO t3_capture_alias_versions VALUES (NEW.admitted_root, hex(randomblob(32)));
      END;
      CREATE TRIGGER IF NOT EXISTS t3_capture_alias_delete_version AFTER DELETE ON t3_capture_root_aliases BEGIN
        DELETE FROM t3_capture_alias_versions WHERE admitted_root = OLD.admitted_root;
      END;
      CREATE TABLE IF NOT EXISTS t3_capture_attempts (
        attempt_id TEXT PRIMARY KEY, admitted_root TEXT NOT NULL, requested_generation TEXT,
        physical_root TEXT, environment_id TEXT, generation TEXT, root_version TEXT, alias_version TEXT,
        outcome TEXT NOT NULL DEFAULT 'pending', failure_code TEXT, withdrew INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  observe(admittedRootKey: string, requestedGeneration?: string): CaptureAttempt {
    return journalTransaction(this.database, () => {
      const attempt = { id: randomUUID() }
      this.database.prepare(`INSERT INTO t3_capture_attempts (attempt_id, admitted_root, requested_generation)
        VALUES (?, ?, ?)`).run(attempt.id, admittedRootKey, requestedGeneration ?? null)
      this.bind(attempt)
      return attempt
    })
  }

  /** Called inside the caller's existing journal transaction immediately after
   * that attempt's begin/recover/complete mutation, never after an await.
   */
  bind(attempt: CaptureAttempt): void {
    const row = this.database.prepare('SELECT * FROM t3_capture_attempts WHERE attempt_id = ?').get(attempt.id)
    requireCapture(row?.outcome === 'pending', 'capture_attempt_not_pending')
    this.database.prepare(`UPDATE t3_capture_attempts SET
      (physical_root, environment_id, generation, root_version, alias_version) = (
        SELECT root.physical_root, root.environment_id, root.generation, rv.version, av.version
        FROM t3_capture_root_aliases AS alias JOIN t3_capture_roots AS root USING (physical_root)
        JOIN t3_capture_root_versions AS rv USING (physical_root)
        JOIN t3_capture_alias_versions AS av USING (admitted_root)
        WHERE alias.admitted_root = t3_capture_attempts.admitted_root
      ) WHERE attempt_id = ?`).run(attempt.id)
  }

  fail(attempt: CaptureAttempt, code: string): void {
    journalTransaction(this.database, () => {
      const row = this.database.prepare('SELECT * FROM t3_capture_attempts WHERE attempt_id = ?').get(attempt.id)
      requireCapture(row?.outcome === 'pending', 'capture_attempt_not_pending')
      requireCapture(['physical_root', 'environment_id', 'generation', 'root_version', 'admitted_root',
        'alias_version', 'requested_generation'].every(key => row[key] !== undefined), 'capture_attempt_invalid')
      const changed = this.database.prepare(`UPDATE t3_capture_roots SET available = 0
        WHERE physical_root = ? AND environment_id = ? AND generation IS ?
        AND (SELECT version FROM t3_capture_root_versions WHERE physical_root = t3_capture_roots.physical_root) = ?
        AND EXISTS (SELECT 1 FROM t3_capture_root_aliases AS alias
          JOIN t3_capture_alias_versions AS av USING (admitted_root)
          WHERE alias.admitted_root = ? AND alias.physical_root = t3_capture_roots.physical_root AND av.version = ?)
        AND (? IS NULL OR generation = ?)`)
        .run(row.physical_root!, row.environment_id!, row.generation!, row.root_version!, row.admitted_root!,
          row.alias_version!, row.requested_generation!, row.requested_generation!)
      this.database.prepare(`UPDATE t3_capture_attempts SET outcome = 'failed', failure_code = ?, withdrew = ?
        WHERE attempt_id = ?`).run(code, Number(changed.changes), attempt.id)
    })
  }

  succeed(attempt: CaptureAttempt): void {
    this.database.prepare("UPDATE t3_capture_attempts SET outcome = 'succeeded' WHERE attempt_id = ? AND outcome = 'pending'")
      .run(attempt.id)
  }
}
