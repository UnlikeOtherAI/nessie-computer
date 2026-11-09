import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as Exit from 'effect/Exit'
import * as SqlClient from 'effect/sql/SqlClient'
import { CommandId, RunId, ThreadId } from '@nessie/t3-session-source/contracts'
import { Outbox, Sqlite, Worker, EffectClaims } from '@nessie/t3-session-source/engine'

// Real original SQLite and outbox methods. Synthetic admission/executor services
// exercise ordering only; they supply no native or current backend authority.
const fixture = async program => {
  const parent = resolve(process.env.T3_RUNTIME_FIXTURE_ROOT ?? join(tmpdir(), 'nessie-session-claim-tests'))
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'claims-'))
  const sql = Sqlite.layerFromPath(join(directory, 'claims.sqlite')).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
  const services = Outbox.layer.pipe(Layer.provideMerge(sql))
  return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(services))))
}
const pending = (id, commandId = id, threadId = id) => ({ id, commandId: CommandId.make(commandId),
  threadId: ThreadId.make(threadId), request: { type: 'provider-turn.start', runId: RunId.make(`run-${id}`) } })
const prepare = (outbox, commandIds, workerId = 'original-worker') => outbox.prepareClaim({ workerId,
  commandIds: commandIds.map(CommandId.make) })
const getCandidate = option => { assert.equal(Option.isSome(option), true); return option.value }
const deadline = (milliseconds = 4_000) => ({ notAfterMs: Date.now() + milliseconds,
  notAfterMonotonicMs: performance.now() + milliseconds })
const failed = effect => effect.pipe(Effect.result, Effect.map(result => assert.equal(result._tag, 'Failure')))
const rowState = id => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_id = ${id}`)[0]
})
const withWorker = (authority, execute, program) => Effect.gen(function* () {
  const layer = Worker.sessionLayerWithOptions({ workerId: 'protected-worker' }).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(EffectClaims.SessionEffectClaimAuthority, authority),
    Layer.succeed(Worker.OrchestrationEffectExecutorV2, { execute }),
  )))
  const context = yield* Layer.build(layer)
  return yield* program.pipe(Effect.provide(context))
})
const authority = (commands, withClaim) => ({ commands: Effect.succeed(commands.map(CommandId.make)),
  awaitChanged: Effect.never, withClaim })

test('the actual original candidate hashes the shared native fixture including its physical lease expiry', async () => {
  const data = JSON.parse(await readFile(new URL('./fixtures/pending-effect-row.json', import.meta.url), 'utf8'))
  await fixture(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = Object.keys(data.row)
    yield* sql.unsafe(`INSERT INTO orchestration_v2_effect_outbox (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => data.row[column]))
    const outbox = yield* Outbox.EffectOutboxV2
    const candidate = getCandidate(yield* prepare(outbox, [data.row.command_id]))
    assert.equal(candidate.rowDigest, data.rowDigest)
    assert.deepEqual({ ...yield* rowState(data.row.effect_id) }, data.row)
  }))
})

test('a destination with an unrecognized physical outbox column cannot prepare a claim snapshot', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    const sql = yield* SqlClient.SqlClient
    yield* outbox.enqueue([pending('altered-schema')])
    yield* sql`ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN unrecognized_column TEXT`
    const before = yield* rowState('altered-schema')
    yield* failed(prepare(outbox, ['altered-schema']))
    assert.deepEqual(yield* rowState('altered-schema'), before)
  }))
})

test('live schema checks refuse changes hidden by cached row metadata and changes after preparation', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    const sql = yield* SqlClient.SqlClient
    yield* outbox.enqueue([pending('cached-schema')])
    const candidate = getCandidate(yield* prepare(outbox, ['cached-schema']))
    const before = yield* rowState('cached-schema')
    yield* sql`ALTER TABLE orchestration_v2_effect_outbox ADD COLUMN unrecognized_column TEXT`
    yield* failed(prepare(outbox, ['cached-schema']))
    assert.equal(Option.isNone(yield* outbox.claimPrepared({ candidate, ...deadline() })), true)
    const after = yield* rowState('cached-schema')
    for (const [column, value] of Object.entries(before)) assert.equal(after[column], value)
    const physical = yield* sql`SELECT status, attempt_count, lease_owner, unrecognized_column
      FROM orchestration_v2_effect_outbox WHERE effect_id = 'cached-schema'`
    assert.deepEqual({ ...physical[0] }, { status: 'pending', attempt_count: 0,
      lease_owner: null, unrecognized_column: null })
  }))
})

test('preparing a candidate is read-only; one conditional transition uses its exact retained row and worker', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('one', 'original-command', 'thread')])
    const before = yield* rowState('one')
    const candidate = getCandidate(yield* prepare(outbox, ['original-command']))
    assert.deepEqual(yield* rowState('one'), before)
    assert.equal(candidate.rowDigest, 'sha256:' + createHash('sha256').update(JSON.stringify([
      'nessie.t3.pending-effect-row.v1', before.effect_id, before.command_id, before.thread_id,
      before.effect_type, before.payload_json, before.status, before.attempt_count, before.available_at,
      before.lease_owner, before.lease_expires_at, before.created_at, before.updated_at, before.completed_at,
      before.last_error,
    ])).digest('hex'))
    const escaped = candidate.effect
    escaped.commandId = 'substituted-command'
    escaped.request.runId = 'substituted-run'
    assert.equal(candidate.effect.commandId, 'original-command')
    assert.equal(candidate.effect.request.runId, 'run-one')
    const claimed = getCandidate(yield* outbox.claimPrepared({ candidate, ...deadline() }))
    assert.equal(claimed.commandId, 'original-command')
    assert.equal(claimed.request.runId, 'run-one')
    assert.equal(claimed.status, 'running')
    assert.equal(claimed.attemptCount, 1)
    assert.equal(claimed.leaseOwner, 'original-worker')
    yield* failed(outbox.claimPrepared({ candidate, ...deadline() }))
    assert.throws(() => candidate.effect, /claim-candidate-closed/u)
    assert.throws(() => candidate.rowDigest, /claim-candidate-closed/u)
  }))
})

test('closed candidates, object copies and candidates from another outbox cannot claim a row', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('closed')])
    const candidate = getCandidate(yield* Effect.scoped(prepare(outbox, ['closed'])))
    const before = yield* rowState('closed')
    yield* failed(outbox.claimPrepared({ candidate, ...deadline() }))
    yield* failed(outbox.claimPrepared({ candidate: { effect: pending('closed') }, ...deadline() }))
    const live = getCandidate(yield* prepare(outbox, ['closed']))
    const other = yield* Layer.build(Layer.fresh(Outbox.layer))
    const otherOutbox = yield* Outbox.EffectOutboxV2.pipe(Effect.provide(other))
    assert.notEqual(otherOutbox, outbox)
    yield* failed(otherOutbox.claimPrepared({ candidate: live, ...deadline() }))
    assert.deepEqual(yield* rowState('closed'), before)
  }))
})

test('an expired candidate cannot be renewed and a changed or cancelled row is never claimed', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    const sql = yield* SqlClient.SqlClient
    for (const mode of ['expired', 'payload', 'cancelled', 'attempt', 'physical-lease-expiry']) {
      yield* outbox.enqueue([pending(mode)])
      const candidate = getCandidate(yield* prepare(outbox, [mode]))
      if (mode === 'expired') {
        const before = yield* rowState(mode)
        yield* failed(outbox.claimPrepared({ candidate, ...deadline(-1) }))
        yield* failed(outbox.claimPrepared({ candidate, ...deadline() }))
        assert.deepEqual(yield* rowState(mode), before)
        continue
      }
      if (mode === 'payload') yield* sql`UPDATE orchestration_v2_effect_outbox
        SET payload_json = '{"type":"provider-turn.start","runId":"replacement"}' WHERE effect_id = ${mode}`
      if (mode === 'attempt') yield* sql`UPDATE orchestration_v2_effect_outbox
        SET attempt_count = attempt_count + 1 WHERE effect_id = ${mode}`
      if (mode === 'physical-lease-expiry') yield* sql`UPDATE orchestration_v2_effect_outbox
        SET lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE effect_id = ${mode}`
      if (mode === 'cancelled') yield* outbox.cancelUnsettled({ threadId: ThreadId.make(mode),
        effectTypes: ['provider-turn.start'], reason: 'synthetic cancellation' })
      const before = yield* rowState(mode)
      assert.equal(Option.isNone(yield* outbox.claimPrepared({ candidate, ...deadline() })), true)
      assert.deepEqual(yield* rowState(mode), before)
    }
  }))
})

test('competing candidates can transition their shared row only once', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('race')])
    const first = getCandidate(yield* prepare(outbox, ['race'], 'first-worker'))
    const second = getCandidate(yield* prepare(outbox, ['race'], 'second-worker'))
    const results = yield* Effect.all([first, second].map(candidate =>
      outbox.claimPrepared({ candidate, ...deadline() })), { concurrency: 2 })
    assert.equal(results.filter(Option.isSome).length, 1)
    assert.equal((yield* rowState('race')).attempt_count, 1)
  }))
})

test('the SQL transition refuses expiry that occurs while waiting behind the actual transaction connection', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    const sql = yield* SqlClient.SqlClient
    yield* outbox.enqueue([pending('late')])
    const before = yield* rowState('late')
    const candidate = getCandidate(yield* prepare(outbox, ['late']))
    const entered = yield* Deferred.make(), release = yield* Deferred.make()
    const holding = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT 1`
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const claiming = yield* outbox.claimPrepared({ candidate, ...deadline(200) }).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    assert.throws(() => candidate.effect, /claim-candidate-closed/u)
    yield* Effect.sleep('300 millis')
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holding)
    assert.equal(Option.isNone(yield* Fiber.join(claiming)), true)
    assert.deepEqual(yield* rowState('late'), before)
  }))
})

test('command filtering retains older per-thread blockers and admits independent threads', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('older', 'unadmitted', 'blocked-thread'),
      pending('later', 'admitted', 'blocked-thread'), pending('independent', 'other-admitted', 'other-thread')])
    const candidate = getCandidate(yield* prepare(outbox, ['admitted', 'other-admitted']))
    assert.equal(candidate.effect.id, 'independent')
    yield* outbox.claimPrepared({ candidate, ...deadline() })
    assert.equal(Option.isNone(yield* prepare(outbox, ['admitted'])), true)
    assert.equal(Option.isNone(yield* outbox.nextClaimableAtForCommands([CommandId.make('admitted')])), true)
    assert.equal((yield* rowState('older')).attempt_count, 0)
    assert.equal((yield* rowState('later')).attempt_count, 0)
  }))
})

test('the actual SQL refuses elapsed monotonic budget even while its wall deadline remains current', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2, sql = yield* SqlClient.SqlClient
    yield* outbox.enqueue([pending('monotonic-wait')])
    const before = yield* rowState('monotonic-wait')
    const candidate = getCandidate(yield* prepare(outbox, ['monotonic-wait']))
    const entered = yield* Deferred.make(), release = yield* Deferred.make()
    const holder = yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT 1`
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    })).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const bound = { notAfterMs: Date.now() + 4_000, notAfterMonotonicMs: performance.now() + 150 }
    const claiming = yield* outbox.claimPrepared({ candidate, ...bound }).pipe(Effect.forkScoped)
    yield* Effect.sleep('250 millis')
    assert.ok(Date.now() < bound.notAfterMs)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    assert.equal(Option.isNone(yield* Fiber.join(claiming)), true)
    assert.deepEqual(yield* rowState('monotonic-wait'), before)
  }))
})

test('an unrecognized outbox trigger cannot execute inside a conditional claim', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2, sql = yield* SqlClient.SqlClient
    yield* outbox.enqueue([pending('trigger')])
    const candidate = getCandidate(yield* prepare(outbox, ['trigger']))
    yield* sql`CREATE TABLE trigger_canary (value TEXT)`
    yield* sql`CREATE TRIGGER unrecognized_outbox_trigger BEFORE UPDATE ON orchestration_v2_effect_outbox
      BEGIN INSERT INTO trigger_canary VALUES ('must not run'); END`
    const before = yield* rowState('trigger')
    assert.equal(Option.isNone(yield* outbox.claimPrepared({ candidate, ...deadline() })), true)
    assert.deepEqual(yield* rowState('trigger'), before)
    assert.equal((yield* sql`SELECT count(*) AS count FROM trigger_canary`)[0].count, 0)
  }))
})

test('protected admission refusal leaves every durable row field unchanged and never reaches the executor', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('refused')])
    const before = yield* rowState('refused')
    let calls = 0
    yield* withWorker(authority(['refused'], () => Effect.fail(new EffectClaims.SessionEffectClaimRefused())),
      () => Effect.sync(() => { calls++ }), Effect.gen(function* () {
        const worker = yield* Worker.OrchestrationEffectWorkerV2
        yield* failed(worker.runOnce)
      }))
    assert.equal(calls, 0)
    assert.deepEqual(yield* rowState('refused'), before)
  }))
})

test('the protected worker cannot be built without its current admission owner', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('unbound')])
    const before = yield* rowState('unbound')
    const built = yield* Effect.exit(Layer.build(Worker.sessionLayer.pipe(Layer.provide(
      Layer.succeed(Worker.OrchestrationEffectExecutorV2, { execute: () => Effect.die('must not execute') })))))
    assert.equal(Exit.isFailure(built), true)
    assert.deepEqual(yield* rowState('unbound'), before)
  }))
})

test('the protected worker preserves original execution/settlement only for the actual admitted conditional result',
  async () => {
    await fixture(Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2
      yield* outbox.enqueue([pending('accepted')])
      const observed = []
      yield* withWorker(authority(['accepted'], (candidate, claim) => Effect.gen(function* () {
        assert.equal(candidate.effect.status, 'pending')
        assert.equal(candidate.effect.attemptCount, 0)
        return yield* claim(deadline())
      })), effect => Effect.sync(() => { observed.push(effect) }), Effect.gen(function* () {
        const worker = yield* Worker.OrchestrationEffectWorkerV2
        assert.equal(yield* worker.runOnce, true)
      }))
      assert.equal(observed.length, 1)
      assert.equal(observed[0].status, 'running')
      assert.equal(observed[0].leaseOwner, 'protected-worker')
      assert.equal((yield* rowState('accepted')).status, 'succeeded')
    }))
  })

test('a fabricated admitted row cannot bypass the original conditional claim callback', async () => {
  await fixture(Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2
    yield* outbox.enqueue([pending('fabricated')])
    const before = yield* rowState('fabricated')
    let calls = 0
    yield* withWorker(authority(['fabricated'], candidate => Effect.succeed(Option.some(candidate.effect))),
      () => Effect.sync(() => { calls++ }), Effect.gen(function* () {
        const worker = yield* Worker.OrchestrationEffectWorkerV2
        yield* failed(worker.runOnce)
      }))
    assert.equal(calls, 0)
    assert.deepEqual(yield* rowState('fabricated'), before)
  }))
})

test('admission cancellation joins without claiming and admission-change wakeups remain separate from outbox writes',
  async () => {
    await fixture(Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2
      yield* outbox.enqueue([pending('cancelled-admission')])
      const entered = yield* Deferred.make(), changed = yield* Deferred.make()
      const gate = { ...authority(['cancelled-admission'], () => Deferred.succeed(entered, undefined)
        .pipe(Effect.andThen(Effect.never))), awaitChanged: Deferred.await(changed) }
      yield* withWorker(gate, () => Effect.die('must not execute'), Effect.gen(function* () {
        const worker = yield* Worker.OrchestrationEffectWorkerV2
        const before = yield* rowState('cancelled-admission')
        const demand = yield* worker.runOnce.pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(demand)
        assert.deepEqual(yield* rowState('cancelled-admission'), before)
        const scope = yield* Scope.make()
        const waking = yield* worker.awaitWork.pipe(Effect.forkIn(scope))
        yield* Deferred.succeed(changed, undefined)
        yield* Fiber.join(waking)
        yield* Scope.close(scope, Exit.void)
      }))
    }))
  })
