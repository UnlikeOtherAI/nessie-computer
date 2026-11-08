import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ProjectId, ProviderInstanceId, ServerSettings } from '@nessie/t3-session-source/contracts'
import { Settings } from '@nessie/t3-session-source/engine'
import { readConfiguredSessionProvider } from '../../dist/t3-session/runtime/configured-provider.js'
import { PreparedSessionLaunchTarget, recheckSessionLaunchTarget } from '../../dist/t3-session/runtime/launch-target.js'

const projectId = ProjectId.make('project-config-inspection')
const instanceId = ProviderInstanceId.make('provider-config-inspection')
const settings = (entry, overrides = {}) => Schema.decodeUnknownSync(ServerSettings)({
  providerInstances: { [instanceId]: entry }, ...overrides,
})
// This supplies settings data only, never a positive graph/native admission.
const read = value => Effect.runPromise(readConfiguredSessionProvider(projectId, instanceId).pipe(
  Effect.provideService(Settings.ServerSettingsReadService, {
    getSettings: Effect.succeed(value),
    start: Effect.die('Inspection must not start the settings owner'),
    ready: Effect.die('Inspection must use an already held settings owner'),
  }),
))

test('configured inspection retains original Claude driver identity without a provider or secret resolver', async () => {
  const result = await read(settings({ driver: 'claudeAgent', config: { homePath: 'C:/held/claude' } }))
  assert.equal(result.instanceId, instanceId)
  assert.equal(result.driverKind, 'claudeAgent')
  assert.equal(Object.hasOwn(result, 'providerSessionId'), false)
  assert.equal(Object.hasOwn(result, 'continuationIdentity'), false)
})

test('inspection refuses explicit disable, unknown drivers and invalid original driver config', async () => {
  for (const entry of [
    { driver: 'codex', enabled: false, config: { enabled: true } },
    { driver: 'codex', enabled: true, config: { enabled: false } },
    { driver: 'unregistered-driver', config: {} },
    { driver: 'codex', config: { binaryPath: 123 } },
  ]) await assert.rejects(read(settings(entry)))
  await assert.rejects(read(settings({ driver: 'codex', config: {} }, {
    projectSettingsOverrides: { [projectId]: { providerInstances: { [instanceId]: { enabled: false } } } },
  })))
  await assert.rejects(read(Schema.decodeUnknownSync(ServerSettings)({})))
})

test('settings changes alter the retained selection even when the provider id is unchanged', async () => {
  const first = await read(settings({ driver: 'codex', config: { homePath: 'C:/held/first' } }))
  const second = await read(settings({ driver: 'codex', config: { homePath: 'C:/held/second' } }))
  assert.notEqual(first.settingsBytes, second.settingsBytes)
})

test('original provider decoder failures do not expose settings values', async () => {
  const marker = 'private-config-marker'
  await assert.rejects(read(settings({ driver: 'codex', config: { binaryPath: { secret: marker } } })), error => {
    assert.match(String(error), /T3_CONFIGURED_PROVIDER_REFUSED/u)
    assert.equal(String(error).includes(marker), false)
    assert.equal(JSON.stringify(error).includes(marker), false)
    return true
  })
})

test('a DTO or constructor call cannot manufacture a prepared original launch target', async () => {
  assert.throws(() => new PreparedSessionLaunchTarget({}, {}, 'generation', {}, {}),
    { name: 'SessionLaunchTargetRefused' })
  await assert.rejects(Effect.runPromise(recheckSessionLaunchTarget({}, {})), /T3_EXECUTING_LAUNCH_TARGET_REFUSED/)
})
