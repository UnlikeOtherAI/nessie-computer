import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { createSessionStateLayers, createSessionReadLayers, LegacyImporter, Sqlite,
  SourceContracts as S } from '@nessie/t3-session-source/engine'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { CapturedIdentity } from '../state/journal.js'
import type { NativeHistoryAlias, NativeHistoryHomePort, RetainedReadScope } from '../ownership/continuity.js'
import type { ProvenT3Source } from './manifest.js'
import type { T3SourceSnapshot, SnapshotReadChecks } from './snapshot-view.js'
import { CapturePrivacy, recheckRow } from './privacy.js'

/** This SQL layer is ONLY the owner's isolated destination, initialized through
 * the normal engine's Sqlite layer. Never pass an admitted source connection.
 */
type OriginalSqliteLayer = ReturnType<typeof Sqlite.layerFromPath>
export type OwnedCaptureSqlError = OriginalSqliteLayer extends Layer.Layer<infer _A, infer E, infer _R> ? E : never
export interface OwnedCaptureStage {
  readonly reference: string
  readonly sql: Layer.Layer<SqlClient.SqlClient, OwnedCaptureSqlError>
}
export interface OwnedCaptureWorkspacePort {
  createGeneration(generation: string): Promise<OwnedCaptureStage>
  reopenGeneration(reference: string): Promise<OwnedCaptureStage>
}

export async function materializeSnapshot(snapshot: T3SourceSnapshot, stage: OwnedCaptureStage,
  reads: SnapshotReadChecks): Promise<void> {
  const privacy = new CapturePrivacy()
  // No raw row is written before the complete correlation preflight.
  await privacy.preflight(snapshot, reads)
  const copy = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      const existing = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`
      const threads = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`
      const legacy = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_threads`
      requireCapture(existing[0]?.count === 0 && threads[0]?.count === 0 && legacy[0]?.count === 0,
        'capture_destination_not_fresh')
      for (const entry of snapshot.tables) {
        const insert = `INSERT OR REPLACE INTO ${entry.name} (${entry.columns.join(', ')}) ` +
          `VALUES (${entry.columns.map(() => '?').join(', ')})`
        for (const sourceRow of snapshot.rows(entry)) {
          yield* Effect.promise(() => recheckRow(reads, entry, sourceRow))
          const row = privacy.row(entry, sourceRow)
          yield* sql.unsafe(insert, entry.columns.map(column => row[column] ?? null))
        }
      }
      // New writes by the ORIGINAL legacy importer must not reuse a pruned or
      // excluded high-water. This changes only the owned destination sequence.
      yield* sql`DELETE FROM sqlite_sequence WHERE name = 'orchestration_events'`
      yield* sql`INSERT INTO sqlite_sequence (name, seq) VALUES ('orchestration_events', ${snapshot.sourceHighWater})`
      yield* Effect.promise(() => reads.recheckSource())
    }))
  })
  try {
    await Effect.runPromise(Effect.scoped(copy.pipe(Effect.provide(stage.sql))))
  } catch {
    throw new CaptureFailure('destination_materialization_incomplete')
  }
}

export interface HydratedCapture {
  readonly identities: readonly CapturedIdentity[]
  readonly aliases: readonly NativeHistoryAlias[]
  readonly nativeHomes: 'proven' | 'required_unbound'
}

/** Every invocation constructs fresh original legacy/read services. On refresh
 * the captured durable markers are reset too; on resume original event IDs
 * make interrupted batches idempotent. No background import that swallows errors.
 */
export async function hydrateCapture(stage: OwnedCaptureStage, source: ProvenT3Source,
  reads: RetainedReadScope, nativeHomes?: NativeHistoryHomePort): Promise<HydratedCapture> {
  const state = createSessionStateLayers()
  const read = createSessionReadLayers(state)
  const program = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    yield* importer.reconcileShells
    const legacy = yield* sql<{ thread_id: string }>`SELECT thread_id FROM orchestration_v2_legacy_imports ORDER BY thread_id`
    for (const row of legacy) {
      yield* Effect.promise(() => reads.recheckThread(S.ThreadId.make(row.thread_id)))
      yield* importer.ensureTranscript(S.ThreadId.make(row.thread_id))
    }
    const pending = yield* importer.pendingThreadCount
    requireCapture(pending === 0, 'legacy_hydration_incomplete')
    const rows = yield* sql<{
      thread_id: string; archived_at: string | null; deleted_at: string | null; payload_json: string
    }>`
      SELECT thread_id, archived_at, deleted_at, payload_json FROM orchestration_v2_projection_threads ORDER BY thread_id`
    const identities: CapturedIdentity[] = rows.map(row => {
      const original = Schema.decodeUnknownSync(S.OrchestrationV2AppThreadJson)(JSON.parse(row.payload_json))
      requireCapture(original.id === row.thread_id, 'source_thread_identity_mismatch')
      return { threadId: original.id,
        state: row.deleted_at !== null ? 'deleted' : row.archived_at !== null ? 'archived' : 'active' }
    })
    const providers = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`
    for (const identity of identities) {
      yield* Effect.promise(() => reads.recheckThread(S.ThreadId.make(identity.threadId)))
    }
    yield* Effect.promise(() => reads.recheckSource())
    return { identities, providers }
  })
  let result: { identities: CapturedIdentity[]; providers: readonly { payload_json: string }[] }
  try {
    result = await Effect.runPromise(Effect.scoped(program.pipe(
      Effect.provide(read.layer.pipe(Layer.provideMerge(stage.sql))),
    )))
  } catch {
    throw new CaptureFailure('original_legacy_hydration_incomplete')
  }
  const aliases: NativeHistoryAlias[] = []
  let allProven = true
  for (const row of result.providers) {
    const providerThread = Schema.decodeUnknownSync(S.OrchestrationV2ProviderThreadJson)(JSON.parse(row.payload_json))
    const ref = providerThread.nativeThreadRef
    if (!providerThread.appThreadId || !ref?.nativeId) continue
    const proof = await nativeHomes?.proveHomes({ source, providerThread })
    if (!proof) { allProven = false; continue }
    aliases.push({ threadId: providerThread.appThreadId, providerThreadId: providerThread.id,
      driver: ref.driver, nativeId: ref.nativeId, strength: ref.strength,
      continuationHomeKey: proof.continuationHomeKey, historyHomeKey: proof.historyHomeKey,
      homeProofReference: proof.homeProofReference })
  }
  return { identities: result.identities, aliases, nativeHomes: nativeHomes && allProven ? 'proven' : 'required_unbound' }
}
