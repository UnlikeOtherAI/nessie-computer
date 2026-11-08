import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as Schema from 'effect/Schema'
import * as Effect from 'effect/Effect'
import { Readable, Writable } from 'node:stream'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { ServerSettings, ProviderInstanceConfig, CodexSettings } from '@nessie/t3-session-source/contracts'
import { ProviderSecretPlan } from '@nessie/t3-session-source/engine'
import { receiveSessionProviderSecretRead } from '../../dist/t3-session/runtime/provider-secret-plan.js'

test('native shared fixture retains the exact original codec hashes and ordered duplicate slots', async () => {
  const load = name => readFile(new URL(`../t3-session-source/fixtures/${name}.json`, import.meta.url), 'utf8')
    .then(JSON.parse)
  const source = await load('execution-secret-plan')
  const expected = await load('execution-secret-plan-expected')
  const settings = Schema.decodeUnknownSync(ServerSettings)(source)
  const entry = settings.providerInstances.chosen
  const sha = value => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')
  assert.equal(sha(Schema.encodeSync(ProviderInstanceConfig)(entry)), expected.providerConfigDigest)
  assert.equal(sha(Schema.encodeSync(ServerSettings)(settings).secretProviders), expected.secretProvidersDigest)
  assert.equal(canonicalExecutorJson(ProviderSecretPlan.planProviderInstanceSecrets(CodexSettings, entry)),
    canonicalExecutorJson(expected.selection))
})

test('shared original slot conversion preserves literal and secret whitespace without ambient fallback', () => {
  const resolve = ProviderSecretPlan.resolveProviderEnvironmentVariable
  const literal = { name: 'LITERAL', value: ' literal ', sensitive: false }
  assert.deepEqual(resolve(literal, 'ignored'), literal)
  const selected = { name: 'SELECTED', sensitive: true,
    value: { provider: 'passwords', reference: 'op://vault/item/field' } }
  assert.deepEqual(resolve(selected, ' value \n'), { ...selected, value: ' value \n' })
  assert.equal(resolve(selected, undefined), undefined)
  assert.equal(resolve(selected, ''), undefined)
  assert.equal(resolve(selected, ' \n\t'), undefined)
  // Duplicate references are independent original destination objects.
  const second = { ...selected, name: 'SECOND' }
  assert.equal(resolve(second, 'second').name, 'SECOND')
  assert.deepEqual(selected.value, { provider: 'passwords', reference: 'op://vault/item/field' })
})

test('unrecognized slot cannot register an installer or acknowledge values; queued buffers are wiped', async () => {
  const bytes = Buffer.from('synthetic private value')
  const input = new Readable({ read() {} })
  input.push(bytes)
  let writes = 0
  const output = new Writable({ write(_chunk, _encoding, done) { writes++; done() } })
  await assert.rejects(Effect.runPromise(receiveSessionProviderSecretRead({},
    { domain: 'invented', keyId: 'key', payload: '{}', signature: 'unsigned' },
    { keyId: 'key', payload: '{}', signature: 'unsigned' }, input, output, new AbortController().signal)),
  /T3_SESSION_SECRET_PLAN_REFUSED/u)
  assert.equal(bytes.every(byte => byte === 0), true)
  assert.equal(writes, 0)
  assert.equal(input.destroyed, true)
  assert.equal(output.destroyed, true)
})
