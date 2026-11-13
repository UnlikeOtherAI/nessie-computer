import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { withSessionShutdownPreparation } from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'
import { shutdownRows as rows, makeShutdownRecovery as make } from './shutdown-fixture.mjs'

// Actual original service and transaction; only the unavailable settings input
// and authority sentinel are synthetic. This grants no production authority.
test('masked shutdown cannot wait indefinitely for the original readonly planning inputs',
  { timeout: 10000 }, async () => {
  await withOriginalState(Effect.gen(function* () {
    const recovery = yield* make(Effect.never)
    const start = performance.now()
    const result = yield* Effect.result(Effect.uninterruptible(withSessionShutdownPreparation({
      withShutdownPreparation: () => Effect.sync(() => assert.fail('unobserved work cannot reach admission')),
    }, recovery)))
    assert.equal(result._tag, 'Failure')
    assert.ok(performance.now() - start < 7000)
    assert.deepEqual(yield* rows, [])
  }))
})
