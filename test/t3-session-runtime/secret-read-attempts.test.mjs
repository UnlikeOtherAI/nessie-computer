import assert from 'node:assert/strict'
import test from 'node:test'
import * as Schema from 'effect/Schema'
import { CodexSettings, ProviderInstanceConfig } from '@nessie/t3-session-source/contracts'
import { ProviderSecretPlan } from '@nessie/t3-session-source/engine'
import { SessionSecretReadAttempts } from '../../dist/t3-session/runtime/secret-read-attempts.js'

const select = environment => ProviderSecretPlan.planProviderInstanceSecrets(CodexSettings,
  Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'codex', environment }))
const reference = { provider: 'passwords', reference: 'op://vault/item/field' }

test('original selection keeps full indices and duplicate references; empty plans require no read', () => {
  const plan = select([{ name: 'LITERAL', value: 'literal' },
    { name: 'FIRST', secret: reference }, { name: 'OTHER', value: 'literal' },
    { name: 'SECOND', secret: reference }])
  assert.deepEqual(plan.environment.map(slot => slot.index), [1, 3])
  assert.deepEqual(plan.references, [reference, reference])
  assert.deepEqual(plan.config, [])
  assert.deepEqual(select([{ name: 'LITERAL', value: 'literal' }]).references, [])
  assert.deepEqual(select([]).references, [])
})

test('new open/plan scopes cannot retry a graph slot after an uncertain read', () => {
  const graph = new AbortController()
  const owner = new SessionSecretReadAttempts(graph.signal, Date.now() + 30_000)
  const first = owner.scope(new AbortController().signal)
  first.claim(1)
  first.close() // Models callback failure/unknown delivery, not successful release.
  const retry = owner.scope(new AbortController().signal)
  assert.throws(() => retry.claim(1), /T3_SESSION_SECRET_READ_ATTEMPT_REFUSED/u)
  assert.doesNotThrow(() => retry.claim(3)) // Same reference, distinct original slot.
  assert.throws(() => first.claim(5), /T3_SESSION_SECRET_READ_ATTEMPT_REFUSED/u)
  retry.close()
})

test('concurrent scopes share terminal claims without waiting for an external outcome', () => {
  const signal = new AbortController().signal
  const owner = new SessionSecretReadAttempts(signal, Date.now() + 30_000)
  const first = owner.scope(signal), second = owner.scope(signal)
  first.claim(255)
  assert.throws(() => second.claim(255))
  for (const index of [-1, 256, 0.5, NaN, Infinity]) assert.throws(() => second.claim(index))
  second.claim(0)
  first.close(); second.close()
})

test('escaped scopes refuse parent loss, caller loss and absolute graph expiry', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const graph = new AbortController(), caller = new AbortController()
  const owner = new SessionSecretReadAttempts(graph.signal, Date.now() + 20)
  const first = owner.scope(caller.signal)
  caller.abort()
  assert.throws(() => first.claim(0))
  const second = owner.scope(new AbortController().signal)
  t.mock.timers.tick(20)
  assert.throws(() => second.claim(0))
  const next = new SessionSecretReadAttempts(graph.signal, Date.now() + 100).scope(graph.signal)
  graph.abort()
  assert.throws(() => next.claim(0))
})
