import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { CommandId, EnvironmentId } from 't3-source:packages/contracts/src/index.ts'
import { EventSink } from './StateLayers.ts'
import { createSessionReadLayers, EnvironmentIdentity, LegacyImporter, Sqlite, ThreadReadService } from './ReadLayers.ts'
import { Forks, historyMessageCount, historyThreadId, seedHistoryFixture, seedLineageFixture } from './HistoryFixture.ts'
import { qualifyRetainedReads } from './HistoryReadsProof.ts'
import { qualifyThreadSync } from './HistorySyncProof.ts'

const host = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer,
  Layer.succeed(EnvironmentIdentity.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make('synthetic-history-environment')),
  }))

const runtime = (path: string) => createSessionReadLayers().layer.pipe(
  Layer.provideMerge(Sqlite.layerFromPath(path)),
  Layer.provideMerge(Forks.layer),
  Layer.provideMerge(host),
)

const durableCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return {
    effects: yield* sql`SELECT * FROM orchestration_v2_effect_outbox`,
    receipts: yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM orchestration_command_receipts`,
  }
})

/** Fresh synthetic directory only. Does not inspect installed providers, credentials or retained T3 databases. */
export const runSessionHistoryProof = async (directory: string) => {
  const path = join(resolve(directory), 'synthetic-history.sqlite')
  assert.equal(existsSync(path), false, 'The proof must create a fresh isolated database.')
  const first = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const imported = yield* seedHistoryFixture
    assert.equal(imported.importedThreadCount, 160)
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter
    const reads = yield* ThreadReadService
    const beforeHydration = yield* importer.pendingThreadCount
    assert.ok(beforeHydration > 0)
    const full = yield* reads.getThreadProjection(historyThreadId)
    assert.equal(full.messages.length, historyMessageCount)
    const idempotent = yield* importer.ensureTranscript(historyThreadId)
    assert.equal(idempotent.importedMessageCount, 0)
    const lineage = yield* seedLineageFixture
    const sink = yield* EventSink.EventSinkV2
    // A real, dormant outbox row proves passive reads never claim or execute imported work.
    const commandId = CommandId.make('history:dormant-command')
    yield* sink.commitCommand({ commandId, threadId: historyThreadId, commandType: 'synthetic-fixture',
      acceptedAt: lineage.run.requestedAt, events: [], effects: [{ id: 'history:dormant-effect', commandId,
        threadId: historyThreadId, request: { type: 'provider-runtime.continue', sourceRunId: lineage.run.id } }] })
    const before = yield* durableCounts
    assert.equal(before.effects.length, 1)
    const retention = yield* qualifyRetainedReads
    assert.deepEqual(yield* durableCounts, before)
    const sync = yield* qualifyThreadSync
    const after = yield* durableCounts
    assert.deepEqual(after.effects, before.effects)
    assert.equal((yield* importer.ensureTranscript(historyThreadId)).importedMessageCount, 0)
    return { retention, sync, effects: after.effects, receiptCount: after.receipts[0]?.count }
  }).pipe(Effect.provide(runtime(path)))))
  // Reopen the exact file through source migrations/read layers; never rebuild an authoritative pruned projection.
  const reopened = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const retention = yield* qualifyRetainedReads
    const counts = yield* durableCounts
    assert.deepEqual(counts.effects, first.effects)
    assert.equal(counts.receipts[0]?.count, first.receiptCount)
    return retention
  }).pipe(Effect.provide(runtime(path)))))
  const probe = new DatabaseSync(':memory:')
  const sqlite = { setAuthorizer: typeof probe.setAuthorizer === 'function', isTransaction: typeof probe.isTransaction }
  probe.close()
  return { ...first.retention, ...first.sync, reopenedHistoryRows: reopened.historyRows,
    legacySecondReadImportedMessages: 0, dormantEffectsPreserved: 1,
    providerServicesConstructed: 0, effectConsumersStarted: 0, node: process.versions.node,
    sqlite, packagedNode22Qualified: false }
}
