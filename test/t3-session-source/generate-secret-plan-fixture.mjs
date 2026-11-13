import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as Schema from 'effect/Schema'
import { canonicalExecutorJson } from '../../packages/protocol/dist/index.js'
import { ServerSettings, ProviderInstanceConfig, CodexSettings }
  from '../../packages/t3-session-source/dist/contracts.js'
import { ProviderSecretPlan } from '../../packages/t3-session-source/dist/engine.js'

// Run after the supported Turbo build. Expected bytes come from the actual
// pinned original codecs and selector, independently of the Rust projection.
const source = JSON.parse(await readFile(new URL('./fixtures/execution-secret-plan.json', import.meta.url), 'utf8'))
const settings = Schema.decodeUnknownSync(ServerSettings)(source)
const entry = settings.providerInstances.chosen
const sha = value => 'sha256:' + createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')
const expected = {
  providerConfigDigest: sha(Schema.encodeSync(ProviderInstanceConfig)(entry)),
  secretProvidersDigest: sha(Schema.encodeSync(ServerSettings)(settings).secretProviders),
  selection: ProviderSecretPlan.planProviderInstanceSecrets(CodexSettings, entry),
  accounts: ['example', 'example'],
}
await writeFile(new URL('./fixtures/execution-secret-plan-expected.json', import.meta.url),
  JSON.stringify(expected, null, 2) + '\n')
