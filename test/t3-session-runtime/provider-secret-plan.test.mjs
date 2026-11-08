import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as Schema from 'effect/Schema'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { ServerSettings, ProviderInstanceConfig, CodexSettings } from '@nessie/t3-session-source/contracts'
import { ProviderSecretPlan } from '@nessie/t3-session-source/engine'

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
