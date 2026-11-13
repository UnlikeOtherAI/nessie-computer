import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ClaudeSettings, ProviderInstanceId } from '@nessie/t3-session-source/contracts'
import { OriginalClaudeAdapter, OriginalClaudeRunner, SelectedClaude } from '@nessie/t3-session-source/engine'
import { createSessionSelectedProvider, createSessionSelectedClaudeProvider, SessionSecretPlanRefused }
  from '../../dist/t3-session/runtime/provider-secret-plan.js'

const input = config => ({ instanceId: ProviderInstanceId.make('selected-claude'),
  displayName: 'Selected Claude', enabled: true, environment: [],
  config: Schema.decodeUnknownSync(ClaudeSettings)(config) })

test('selected original Claude refuses unresolved image and default home before acquiring effect hosts', async () => {
  for (const config of [{}, { binaryPath: 'claude', homePath: 'C:\\held-home' },
    { binaryPath: 'C:\\claude.cmd', homePath: 'C:\\held-home' },
    { binaryPath: 'C:\\claude.exe', homePath: '' }]) {
    const result = await Effect.runPromise(SelectedClaude.SelectedClaudeDriver.create(input(config))
      .pipe(Effect.result))
    assert.equal(result._tag, 'Failure')
    assert.equal(result.failure.detail, 'Selected Claude launch resolution is not admitted.')
  }
})

test('selected Claude services cannot cross instance identity before original configuration reads', async () => {
  const result = await Effect.runPromise(SelectedClaude.SelectedClaudeDriver.create(input({
    binaryPath: 'C:\\claude.exe', homePath: 'C:\\held-home',
  })).pipe(Effect.provideService(SelectedClaude.SelectedClaudeServices, {
    instanceId: ProviderInstanceId.make('different-instance'),
  }), Effect.result))
  assert.equal(result._tag, 'Failure')
  assert.equal(result.failure.detail, 'Selected Claude services belong to another instance.')
})

test('portable original Claude adapter and runner retain their original identities', () => {
  assert.equal(OriginalClaudeAdapter.CLAUDE_PROVIDER, 'claudeAgent')
  assert.equal(SelectedClaude.SelectedClaudeDriver.driverKind, OriginalClaudeAdapter.CLAUDE_PROVIDER)
  assert.equal(typeof OriginalClaudeAdapter.makeClaudeAdapterV2, 'function')
  assert.equal(typeof OriginalClaudeRunner.ClaudeAgentSdkQueryRunner.key, 'string')
  assert.notEqual(SelectedClaude.SelectedClaudeServices.key, OriginalClaudeRunner.ClaudeAgentSdkQueryRunner.key)
})

test('both selected constructors reject unissued plans before any driver or history host', async () => {
  const forbidden = () => assert.fail('unissued plan reached a history host')
  const history = { forkSession: forbidden, subagentLaunchToolUseId: forbidden,
    get assertComplete() { return forbidden() } }
  for (const work of [createSessionSelectedProvider({}, {}),
    createSessionSelectedClaudeProvider({}, {}, history)]) {
    const result = await Effect.runPromise(work.pipe(Effect.result))
    assert.equal(result._tag, 'Failure')
    assert.ok(result.failure instanceof SessionSecretPlanRefused)
  }
})
