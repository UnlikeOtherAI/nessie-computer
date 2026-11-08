import { createHmac } from 'node:crypto'
import type { CaptureDatabase, SqlRow } from '../state/sqlite.js'
import { requireCapture } from '../state/sqlite.js'
import type { ProvenT3Source } from './manifest.js'
import { tablesForLayout, selectCaptureRows, legacyThreads, legacyMessages, legacyPullRequests } from './layout.js'
import type { CaptureTable } from './layout.js'
import type { SourceContracts } from '@nessie/t3-session-source/engine'

export interface T3SourceSnapshot {
  readonly source: ProvenT3Source
  readonly sourceHighWater: number
  readonly tables: readonly CaptureTable[]
  rows(table: CaptureTable): Iterable<SqlRow>
  fingerprint(key: string): { digest: string; legacyDigest: string }
}

/** Liveness checks used by the projection, never an authority constructor.
 * Retained callers obtain these from their admitted read scope; execution
 * callers obtain them inside the recognized protected source snapshot. */
export interface SnapshotReadChecks {
  recheckSource(): Promise<void>
  recheckThread(threadId: SourceContracts.ThreadId): Promise<void>
}

/** A view of an ALREADY pinned source transaction. This owns no connection or
 * transaction and cannot extend the enclosing producer's lifetime. */
export async function withSourceSnapshotView<A>(database: CaptureDatabase, source: ProvenT3Source,
  sourceHighWater: number, assertCurrent: () => void, use: (snapshot: T3SourceSnapshot) => Promise<A>): Promise<A> {
  let active = true
  const tables = tablesForLayout(source.layout)
  const check = () => {
    requireCapture(active, 'source_snapshot_closed_or_table_not_admitted')
    assertCurrent()
  }
  const iterate = function* (entry: CaptureTable) {
    check()
    const iterator = database.prepare(selectCaptureRows(entry)).iterate()
    try {
      for (;;) {
        check()
        const next = iterator.next()
        check()
        if (next.done) return
        yield next.value
      }
    } finally { iterator.return?.() }
  }
  const fingerprint = (entries: readonly CaptureTable[], key: string, sequence: number) => {
    check()
    const hash = createHmac('sha256', key)
    hash.update(JSON.stringify(['t3-capture-snapshot-v1', source.layout, sequence]))
    for (const entry of entries) {
      hash.update(JSON.stringify([entry.name, entry.columns]))
      // Baseline includes ALL frozen legacy rows, including rows excluded from
      // the import view by original-v2 eligibility. Preserve that distinction.
      for (const row of iterate(entry)) {
        hash.update(JSON.stringify(entry.columns.map(column => row[column])))
        hash.update('\n')
      }
    }
    check()
    return hash.digest('hex')
  }
  const view: T3SourceSnapshot = Object.freeze({ source, sourceHighWater, tables,
    rows: function* (entry: CaptureTable) {
      check()
      requireCapture(tables.includes(entry), 'source_snapshot_closed_or_table_not_admitted')
      yield* iterate(entry)
    },
    fingerprint: (key: string) => ({ digest: fingerprint(tables, key, sourceHighWater),
      legacyDigest: fingerprint([legacyThreads, legacyMessages, legacyPullRequests], key, 0) }),
  })
  try { check(); const result = await use(view); check(); return result }
  finally { active = false }
}
