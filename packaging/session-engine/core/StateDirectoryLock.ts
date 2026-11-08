// Exclusive SQLite mechanism adapted from MIT T3 serverOwnership.ts at 25bf84ab.
// Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import { lstatSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class SessionWriterError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SessionWriterError' }
}

const sameFile = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino

/** Lock kernel only. The executor verifies private paths first; this grants no provider or human authority. */
export class StateDirectoryLock {
  #closed = false
  #lost = false
  private constructor(
    readonly directory: string,
    readonly lockPath: string,
    private readonly database: DatabaseSync,
    private readonly directoryIdentity: BigIntStats,
    private readonly lockIdentity: BigIntStats,
  ) {}

  static acquire(directory: string): StateDirectoryLock {
    const lockPath = join(directory, 'server-owner.sqlite')
    const root = lstatSync(directory, { bigint: true })
    const before = lstatSync(lockPath, { bigint: true })
    if (!root.isDirectory() || root.isSymbolicLink() || !before.isFile()
      || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new SessionWriterError('session_state_lock_shape_refused')
    }
    const database = new DatabaseSync(lockPath)
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;')
      const writer = new StateDirectoryLock(directory, lockPath, database, root, before)
      writer.assertCurrent()
      return writer
    } catch (error) {
      database.close()
      if (error instanceof Error && ('errcode' in error && error.errcode === 5
        || 'code' in error && error.code === 'SQLITE_BUSY')) throw new SessionWriterError('session_state_already_owned')
      throw error
    }
  }

  /** Stat only: closing another inode descriptor can release POSIX locks. */
  assertCurrent(): void {
    if (this.#closed || this.#lost) throw new SessionWriterError('session_state_writer_lost')
    try {
      const directory = lstatSync(this.directory, { bigint: true })
      const lock = lstatSync(this.lockPath, { bigint: true })
      if (directory.isSymbolicLink() || lock.isSymbolicLink() || !directory.isDirectory() || !lock.isFile()
        || lock.nlink !== 1n || !sameFile(directory, this.directoryIdentity) || !sameFile(lock, this.lockIdentity)) {
        throw new SessionWriterError('session_state_writer_lost')
      }
    } catch {
      this.#lost = true
      throw new SessionWriterError('session_state_writer_lost')
    }
  }

  /** Not native stop proof. The owning runtime controls resource release ordering. */
  close(): void {
    if (this.#closed) return
    this.database.close()
    this.#closed = true
  }
}
