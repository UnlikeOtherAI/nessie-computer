import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import sqlite from 'node:sqlite'
import threads from 'node:worker_threads'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { realpathSync } from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Contracts from '@nessie/t3-session-source/contracts'

const constructors = [[childProcess, 'spawn'], [childProcess, 'spawnSync'], [childProcess, 'exec'],
  [childProcess, 'execSync'], [childProcess, 'execFile'], [childProcess, 'execFileSync'], [childProcess, 'fork'],
  [sqlite, 'DatabaseSync'], [threads, 'Worker']]
const originals = constructors.map(([owner, key]) => owner[key])
let starts = 0
for (const [owner, key] of constructors) owner[key] = () => {
  starts++
  throw new Error('Import/factory attempted a process, worker or database side effect.')
}
syncBuiltinESMExports()
let engine
try {
  engine = await import('@nessie/t3-session-source/engine')
  assert.equal(engine.ORCHESTRATION_PROTOCOL_VERSION, 2)
  const masked = engine.RequestPrivacy.createRequestPrivacyProjector()({
    id: 'synthetic:question', isSecret: true, initialAnswer: 'synthetic:private',
  })
  assert.equal(masked.initialAnswer, '[REDACTED]')
  const state = engine.createSessionStateLayers()
  const reads = engine.createSessionReadLayers(state)
  const higher = engine.createSessionEngineLayers(state)
  const runtime = engine.createSessionRuntimeLayers(state)
  assert.equal(reads.state, state)
  assert.equal(higher.state, state)
  assert.equal(runtime.state, state)
  assert.equal(runtime.engine.state, state)
  assert.equal(Layer.isLayer(runtime.layer), true)
  assert.equal(state.outbox, engine.Outbox.layer)
  assert.equal(Layer.isLayer(reads.layer), true)
  assert.equal(Layer.isLayer(higher.shared), true)
  assert.equal(starts, 0)
  for (const name of ['qualifySessionCoBuild', 'runSessionHistoryProof', 'runSessionStateProof']) {
    assert.equal(name in engine, false)
  }
  assert.equal('layer' in engine.Threads, false)
} finally {
  constructors.forEach(([owner, key], index) => { owner[key] = originals[index] })
  syncBuiltinESMExports()
}
assert.equal(engine.SourceContracts.ThreadId, Contracts.ThreadId)
assert.equal(engine.SourceContracts.OrchestrationV2Command, Contracts.OrchestrationV2Command)
assert.equal(engine.SourceContracts.SecretRequestAnswerInput, Contracts.SecretRequestAnswerInput)
const value = ' \r\n synthetic\u0000value\t 雪🔐 \r\n '
const answer = Schema.decodeUnknownSync(Contracts.SecretRequestAnswerInput)({
  threadId: 'synthetic:consumer', turnItemId: 'synthetic:request', answer: { type: 'save', secret: value },
})
assert.equal(answer.answer.secret, value)
assert.equal(Schema.encodeSync(engine.SourceContracts.SecretRequestAnswerInput)(answer).answer.secret, value)
// A service supplied by the ordinary consumer is read through the original engine Context tag.
const identity = { getEnvironmentId: Effect.succeed(Contracts.EnvironmentId.make('synthetic:consumer')) }
const found = await Effect.runPromise(Effect.gen(function* () {
  return yield* engine.EnvironmentIdentity.ServerEnvironmentIdentity
}).pipe(
  Effect.provideService(engine.EnvironmentIdentity.ServerEnvironmentIdentity, identity)))
assert.equal(found, identity)
const require = createRequire(import.meta.url)
const fromEngine = createRequire(require.resolve('@nessie/t3-session-source/engine'))
const consumerEffect = realpathSync(require.resolve('effect/package.json'))
assert.equal(realpathSync(fromEngine.resolve('effect/package.json')), consumerEffect)
assert.equal(require('effect/package.json').version, '4.1.2')
const helper = await import('@nessie/t3-session-source/build')
assert.equal(helper.T3_CONTRACTS_SOURCE_ENTRY, 't3-source:packages/contracts/src/index.ts')
assert.equal(typeof helper.sessionContractsAliasPlugin, 'function')
console.log(JSON.stringify({ node: process.versions.node, ordinaryPackageImport: true, consumerEffect,
  codecAndContextIdentity: true, sideEffectsDuringImportAndFactories: starts, syntheticExports: false }))
