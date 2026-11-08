import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as Schema from 'effect/Schema'
import { ClaudeSettings, CodexSettings, ProviderInstanceConfigMap, ServerSettings } from '@nessie/t3-session-source/contracts'

const fixture = JSON.parse(readFileSync(new URL('../t3-session-source/fixtures/execution-settings.json', import.meta.url), 'utf8'))

test('held settings fixture uses the original Claude and Codex codecs without starting a provider', () => {
  const settings = Schema.decodeUnknownSync(ServerSettings)(fixture)
  const entries = Schema.decodeUnknownSync(ProviderInstanceConfigMap)(fixture.providerInstances)
  assert.deepEqual(settings.providerInstances, entries)
  const claude = entries['claude-original']
  assert.equal(claude.driver, 'claudeAgent')
  const claudeConfig = Schema.decodeUnknownSync(ClaudeSettings)(claude.config)
  assert.equal(claudeConfig.enabled, true)
  assert.equal(claudeConfig.homePath, 'C:\\fixture\\claude-explicit')
  const codex = entries['codex-original']
  assert.equal(codex.driver, 'codex')
  const codexConfig = Schema.decodeUnknownSync(CodexSettings)(codex.config)
  assert.equal(codexConfig.setupMode, 'existing')
  assert.equal(codexConfig.homePath, 'C:\\fixture\\codex-shared')
  assert.equal(codexConfig.shadowHomePath, 'C:\\fixture\\codex-shadow')
  const claudeWithCodexFields = Schema.decodeUnknownSync(ClaudeSettings)({
    ...claude.config, setupMode: 'managed', shadowHomePath: codexConfig.shadowHomePath,
  })
  assert.equal(Object.hasOwn(claudeWithCodexFields, 'setupMode'), false)
  assert.equal(Object.hasOwn(claudeWithCodexFields, 'shadowHomePath'), false)
  assert.equal(claudeWithCodexFields.homePath, claudeConfig.homePath)
})
