import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { Recovery, SessionLifecycleActionRefused, withSessionShutdownPreparation } from '@nessie/t3-session-source/engine'
import { withOriginalState } from './outbox-fixture.mjs'
import { seedShutdownThread as seed, shutdownRows as rows, makeShutdownRecovery as make,
  shutdownDeadline as deadline } from './shutdown-fixture.mjs'

// Synthetic admission owners around the real original whole-plan writer. No
// enrolled native/backend owner or production lifecycle permission is implied.
const refused = effect => Effect.result(effect).pipe(Effect.map(result => assert.equal(result._tag, 'Failure')))

test('shutdown authority receives every actual selected target before invoking the original prepared writer', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first').pipe(Effect.andThen(seed('second')))
    const recovery = yield* make()
    let selected
    yield* withSessionShutdownPreparation({ withShutdownPreparation: (candidate, write) => {
      assert.deepEqual(candidate.threadIds, ['first', 'second'])
      assert.deepEqual(candidate.effects.map(effect => effect.threadId), ['first', 'second'])
      selected = candidate
      return write(deadline(candidate))
    } }, recovery)
    assert.deepEqual((yield* rows).map(row => row.thread_id), ['first', 'second'])
    assert.throws(() => selected.planDigest, error => error instanceof Recovery.ProviderRuntimeRecoveryError
      && error.cause === 'shutdown-plan-closed')
  }))
})
test('denied or skipped whole-plan admission cannot write, retain its candidate or escape its issued writer', async () => {
  for (const mode of ['denied', 'skipped']) await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const recovery = yield* make()
    let candidate, escaped, cap
    yield* refused(withSessionShutdownPreparation({ withShutdownPreparation: (plan, write) => {
      candidate = plan; escaped = write; cap = deadline(plan)
      return mode === 'denied' ? Effect.fail(new SessionLifecycleActionRefused()) : Effect.void
    } }, recovery))
    yield* refused(escaped(cap))
    yield* refused(recovery.prepareForShutdownPrepared({ candidate, ...cap }))
    assert.deepEqual(yield* rows, [])
  }))
})

test('whole-plan authority cannot repeat an issued writer or turn its actual SQL refusal into success', async () => {
  for (const mode of ['repeat', 'promote-failure']) await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const recovery = yield* make(), sql = yield* SqlClient.SqlClient
    yield* refused(withSessionShutdownPreparation({ withShutdownPreparation: (candidate, write) =>
      Effect.gen(function* () {
        const cap = deadline(candidate)
        if (mode === 'promote-failure') {
          yield* sql.unsafe(`CREATE TRIGGER refuse_prepared BEFORE INSERT ON orchestration_v2_effect_outbox
            BEGIN SELECT RAISE(ABORT, 'synthetic SQL refusal'); END`)
          return yield* write(cap).pipe(Effect.catch(() => Effect.void))
        }
        yield* write(cap)
        yield* write(cap)
      }),
    }, recovery))
    assert.equal((yield* rows).length, mode === 'repeat' ? 1 : 0)
  }))
})

test('whole-plan preparation owns a fresh finite scope when called by an enclosing graph finalizer', async () => {
  await withOriginalState(Effect.gen(function* () {
    yield* seed('first')
    const recovery = yield* make()
    yield* Effect.scoped(Effect.addFinalizer(() => withSessionShutdownPreparation({
      withShutdownPreparation: (candidate, write) => write(deadline(candidate)),
    }, recovery).pipe(Effect.orDie)))
    assert.equal((yield* rows).length, 1)
  }))
})

