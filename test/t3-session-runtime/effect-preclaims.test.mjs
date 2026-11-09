import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import { makeSessionPreclaimHost, recognizeSessionPreclaimHost }
  from '../../dist/t3-session/runtime/effect-preclaims.js'
import { makeSessionCommandLineageRegistry } from '../../dist/t3-session/runtime/command-lineage-registry.js'

// These failure-only fixtures cannot issue a resource, native receipt or grant.
const refused = async effect => assert.equal((await Effect.runPromise(Effect.result(effect)))._tag, 'Failure')
const fabricatedSource = { signal: new AbortController().signal }
const graph = {}, descriptor = {}, binding = {}

test('preclaim factory cannot promote a fabricated source or call SQL after failed resource recognition', async () => {
  let transport = 0, sql = 0
  const host = makeSessionPreclaimHost(fabricatedSource, graph, binding, descriptor,
    { preclaim: async () => { transport++; assert.fail('transport reached') } },
    { assertProviderTurnStart: () => Effect.void }, new AbortController().signal)
  await refused(host.withClaim({ effect: { id: 'synthetic-row' }, rowDigest: 'synthetic' },
    () => Effect.sync(() => { sql++; assert.fail('SQL reached') })))
  assert.equal(transport, 0)
  assert.equal(sql, 0)
  await host.close()
  assert.throws(() => recognizeSessionPreclaimHost(host))
})

test('host closure interrupts and joins a waiting original lineage Effect before returning', async () => {
  const entered = Deferred.makeUnsafe(), stopped = Deferred.makeUnsafe()
  const host = makeSessionPreclaimHost(fabricatedSource, graph, binding, descriptor, {},
    { assertProviderTurnStart: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never),
      Effect.ensuring(Deferred.succeed(stopped, undefined))) }, new AbortController().signal)
  const work = Effect.runPromise(Effect.result(host.withClaim({ effect: { id: 'synthetic' } },
    () => Effect.die('must not write'))))
  await Effect.runPromise(Deferred.await(entered))
  await host.close()
  assert.equal(Deferred.isDoneUnsafe(stopped), true)
  assert.equal((await work)._tag, 'Failure')
})

test('registry rejects a raw claim host and command reads cannot consume a retirement wake', async () => {
  const registry = makeSessionCommandLineageRegistry(new AbortController().signal)
  const owner = registry.register({ commandId: 'parent', threadId: 'thread' }, async () => {},
    new AbortController().signal)
  assert.throws(() => registry.bindPreclaims(owner, { signal: new AbortController().signal,
    withClaim: () => Effect.die('must not run'), close: async () => {} }))
  owner.close()
  assert.deepEqual(await Effect.runPromise(registry.effectClaims.commands), [])
  assert.deepEqual(await Effect.runPromise(registry.effectClaims.commands), [])
  // Deadline makes a lost wake fail rather than hanging the test process.
  await Effect.runPromise(registry.effectClaims.awaitChanged.pipe(Effect.timeout('1 second')))
  registry.close()
})
