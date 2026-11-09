import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { withSessionShutdownPreparation } from '@nessie/t3-session-source/engine'
import { makeSessionShutdownHost } from '../../dist/t3-session/runtime/shutdown-authority.js'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread, makeShutdownRecovery, shutdownRows } from './shutdown-fixture.mjs'

test('an asserted resource or retired native shutdown host cannot prepare permission or write the actual outbox', async () => {
  const sample = JSON.parse(await readFile(new URL('./fixtures/execution-shutdown.json', import.meta.url), 'utf8'))
  for (const closed of [false, true]) await withOriginalState(Effect.gen(function* () {
    yield* seedShutdownThread('refused-native-owner')
    const recovery = yield* makeShutdownRecovery()
    let calls = 0
    const unsupported = () => { calls++; throw Error('native permission must require an issued source') }
    const source = { signal: new AbortController().signal, recheck: async () => undefined,
      prepareShutdown: unsupported, consumeShutdown: unsupported }
    const graph = { custody: sample.preparation.evidence.custody }, descriptor = { custody: graph.custody }
    const host = makeSessionShutdownHost(source, graph, sample.preparation.binding, descriptor,
      { prepareShutdown: unsupported }, new AbortController().signal)
    if (closed) yield* Effect.promise(() => host.close())
    const result = yield* withSessionShutdownPreparation(host, recovery).pipe(Effect.result)
    assert.equal(result._tag, 'Failure')
    assert.equal(calls, 0)
    assert.deepEqual(yield* shutdownRows, [])
    yield* Effect.promise(() => host.close())
  }))
})
