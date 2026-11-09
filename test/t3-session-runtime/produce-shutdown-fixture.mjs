import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { ProjectionStore, ShutdownSelection } from '@nessie/t3-session-source/engine'
import { OrchestrationV2ThreadProjection } from '@nessie/t3-session-source/contracts'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread, makeShutdownRecovery, shutdownDeadline } from './shutdown-fixture.mjs'

// Actual original selector/codecs/SQLite; all records and keys are synthetic.
// This fixture cannot establish native enrollment or positive mutation authority.
const hash = value => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')
const fields = OrchestrationV2ThreadProjection.fields
const codec = Schema.Struct(Object.fromEntries(['thread', 'runs', 'attempts', 'nodes', 'subagents',
  'providerSessions', 'providerThreads', 'providerTurns', 'runtimeRequests', 'messages', 'turnItems']
  .map(key => [key, fields[key]])))
const encode = Schema.encodeSync(codec)
const queries = JSON.parse(await readFile(new URL('../../windows-common/src/execution_recovery_queries.json',
  import.meta.url), 'utf8'))
const sample = JSON.parse(await readFile(new URL('./fixtures/execution-legacy-shell.json', import.meta.url), 'utf8'))
const result = await withOriginalState(Effect.gen(function* () {
  yield* seedShutdownThread('shutdown:雪')
  const projections = yield* ProjectionStore.ProjectionStoreV2
  const recovery = yield* makeShutdownRecovery(), plan = yield* recovery.prepareShutdownPlan
  const projection = yield* projections.getRuntimeRecoveryProjection('shutdown:雪')
  const at = DateTime.makeUnsafe(plan.observedAtMs), cases = []
  const capture = (name, value) => cases.push({ name, projection: encode(value),
    runId: ShutdownSelection.restartContinuationRun(value, at)?.id ?? null })
  capture('running', projection)
  capture('archived', { ...projection, thread: { ...projection.thread, archivedAt: at } })
  capture('deleted', { ...projection, thread: { ...projection.thread, deletedAt: at } })
  capture('settled', { ...projection, thread: { ...projection.thread, settledOverride: 'settled' } })
  capture('snoozed', { ...projection, thread: { ...projection.thread,
    snoozedUntil: DateTime.makeUnsafe(plan.observedAtMs + 10000) } })
  capture('snooze-expired', { ...projection, thread: { ...projection.thread,
    snoozedUntil: DateTime.makeUnsafe(plan.observedAtMs - 1) } })
  for (const status of ['failed', 'cancelled', 'queued', 'completed', 'waiting', 'starting']) {
    capture(status, { ...projection, runs: projection.runs.map(run => ({ ...run, status })) })
  }
  capture('prepared', { ...projection, runs: projection.runs.map(run => ({ ...run,
    status: 'starting', restartContinuationOfRunId: 'previous:run' })) })
  capture('weak-native', { ...projection, providerThreads: projection.providerThreads.map(value => ({ ...value,
    nativeThreadRef: { ...value.nativeThreadRef, strength: 'weak' } })) })
  capture('closed-provider', { ...projection, providerThreads: projection.providerThreads.map(value => ({ ...value,
    status: 'closed' })) })
  capture('session-error', { ...projection, providerSessions: projection.providerSessions.map(value => ({ ...value,
    status: 'error' })) })
  capture('turn-completed', { ...projection, providerTurns: projection.providerTurns.map(value => ({ ...value,
    status: 'completed' })) })
  capture('completed-awaited', { ...projection, runs: projection.runs.map(value => ({ ...value, status: 'completed' })),
    providerThreads: projection.providerThreads.map(value => ({ ...value, pendingBackgroundTasks: [{
      kind: 'background_task', taskId: 'synthetic:task', description: 'synthetic', awaited: true,
    }] })) })
  const sql = yield* SqlClient.SqlClient, tables = {}
  capture('never-started', { ...projection, runs: projection.runs.map(run => ({ ...run, startedAt: null })) })
  capture('prepared-before-start', { ...projection, runs: projection.runs.map(run => ({ ...run,
    status: 'starting', startedAt: null, restartContinuationOfRunId: 'previous:run' })) })
  capture('unfinished-precedes-later-ordinal-ended-run', { ...projection, runs: [...projection.runs,
    { ...projection.runs[0], id: 'ended:later', ordinal: 2, status: 'completed',
      completedAt: DateTime.makeUnsafe(plan.observedAtMs - 1000) }] })
  capture('latest-turn-blocks-running-source', { ...projection, providerTurns: [...projection.providerTurns,
    { ...projection.providerTurns[0], id: 'turn:later', ordinal: 2, status: 'completed' }] })
  const forward = encode({ ...projection, runs: projection.runs.map(run => ({ ...run, status: 'completed' })) })
  forward.providerThreads[0].pendingBackgroundTasks = [{ kind: 'future_background_task', taskId: 'synthetic:future' }]
  const normalized = Schema.decodeUnknownSync(codec)(forward)
  cases.push({ name: 'forward-compatible-background-task', projection: forward,
    runId: ShutdownSelection.restartContinuationRun(normalized, at)?.id ?? null })
  for (const table of [...queries.tables, 'orchestration_v2_effect_outbox']) {
    tables[table] = (yield* sql.unsafe(`SELECT * FROM ${table}`)).map(row => ({ ...row }))
  }
  const schema = yield* sql.unsafe(`SELECT sql FROM sqlite_schema WHERE tbl_name IN (
    ${Object.keys(tables).map(() => '?').join(',')}) AND type IN ('table','index') AND sql IS NOT NULL
    ORDER BY type DESC, name`, Object.keys(tables))
  const observation = { version: 1, observedAtMs: plan.observedAtMs, selectionAtMs: plan.observedAtMs,
    authorityDigest: plan.authorityDigest, targets: plan.projectionInputs, effects: plan.effects }
  const preparation = { ...sample.preparation, action: 'prepare-shutdown', observation,
    issuedAtMs: plan.observedAtMs, expiresAtMs: plan.observedAtMs + 5000 }
  const slotId = hash({ domain: 'nessie.t3.execution.shutdown-slot.v1', executorId: preparation.binding.executorId,
    sourceEvidenceDigest: preparation.binding.sourceEvidenceDigest,
    acceptedGraphNonce: preparation.acceptedGraphNonce })
  preparation.slotId = slotId.slice(7); preparation.nonce = preparation.slotId
  yield* recovery.prepareForShutdownPrepared({ candidate: plan, ...shutdownDeadline(plan) })
  const existingPlan = yield* recovery.prepareShutdownPlan
  const existingRow = { ...(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`)[0] }
  const existingObservation = { ...observation, observedAtMs: existingPlan.observedAtMs,
    selectionAtMs: existingPlan.observedAtMs, authorityDigest: existingPlan.authorityDigest,
    effects: existingPlan.effects }
  return { preparation, settings: { continueThreadsAfterServerUpdate: true, projectSettingsOverrides: {} },
    schema: schema.map(row => row.sql), tables, cases, existingRow, existingObservation }
}))
await writeFile(new URL('./fixtures/execution-shutdown.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ cases: result.cases.length,
  authorityDigest: result.preparation.observation.authorityDigest }))
