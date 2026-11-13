import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { LegacyImporter, withSessionLegacyShellReconciliation } from '@nessie/t3-session-source/engine'
import { makeSessionLegacyShellHost } from '../../dist/t3-session/runtime/legacy-shell-authority.js'
import { withOriginalState } from './outbox-fixture.mjs'

test('an asserted resource or closed shell host cannot reach native preparation or the original writer', async () => {
  const sample = JSON.parse(await readFile(new URL('./fixtures/execution-legacy-shell.json', import.meta.url), 'utf8'))
  for (const closed of [false, true]) await withOriginalState(Effect.gen(function* () {
    const context = yield* Layer.build(LegacyImporter.layer)
    const importer = yield* LegacyImporter.LegacyV1ThreadImporter.pipe(Effect.provide(context))
    let calls = 0
    const unsupported = () => { calls++; throw Error('must never reach native without issued source') }
    const source = { signal: new AbortController().signal, recheck: async () => undefined,
      prepareLegacyShells: unsupported, consumeLegacyShells: unsupported }
    const graph = { custody: sample.preparation.evidence.custody }, descriptor = { custody: graph.custody }
    const host = makeSessionLegacyShellHost(source, graph, sample.preparation.binding, descriptor,
      { legacyShells: unsupported }, new AbortController().signal)
    if (closed) yield* Effect.promise(() => host.close())
    const result = yield* withSessionLegacyShellReconciliation(host, importer).pipe(Effect.result)
    assert.equal(result._tag, 'Failure')
    assert.equal(calls, 0)
    const sql = yield* SqlClient.SqlClient
    assert.equal((yield* sql`SELECT * FROM orchestration_events`).length, 0)
    yield* Effect.promise(() => host.close())
    assert.equal(host.signal.aborted, true)
  }))
})
