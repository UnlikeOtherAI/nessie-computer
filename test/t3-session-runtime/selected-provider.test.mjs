import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { CodexSettings, ManagedPolicySummary, ProviderDriverKind, ProviderInstanceConfig, ProviderInstanceId }
  from '@nessie/t3-session-source/contracts'
import { SelectedProvider } from '@nessie/t3-session-source/engine'

test('selected original registry decodes one entry without a resolver and retires its view on close', async () => {
  const instanceId = ProviderInstanceId.make('selected-original')
  const entry = Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'codex',
    config: { homePath: 'C:\\held-home' }, environment: [{ name: 'LITERAL', value: ' exact ' }] })
  const calls = []
  const closed = []
  const instance = Object.freeze({ instanceId })
  const driver = { driverKind: ProviderDriverKind.make('codex'), configSchema: CodexSettings,
    metadata: { displayName: 'Codex', supportsMultipleInstances: true },
    defaultConfig: () => Schema.decodeSync(CodexSettings)({}),
    create: input => Effect.gen(function* () {
      calls.push(input)
      yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(instanceId)))
      return instance
    }) }
  let escaped
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const registry = yield* SelectedProvider.makeSelectedProviderInstance({ driver, instanceId, entry, managedPolicy: undefined,
      secrets: { environment: [{ name: 'LITERAL', value: ' exact ', sensitive: false }], config: [] } })
    escaped = registry
    assert.equal(yield* registry.getInstance(instanceId), instance)
    assert.equal(yield* registry.getInstance(ProviderInstanceId.make('unselected')), undefined)
    assert.deepEqual(yield* registry.listInstances, [instance])
    assert.deepEqual(yield* registry.listUnavailable, [])
  })))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].config.homePath, 'C:\\held-home')
  assert.equal(calls[0].config.shadowHomePath, '') // Original codec defaults.
  assert.equal(calls[0].environment[0].value, ' exact ')
  assert.deepEqual(closed, [instanceId])
  assert.deepEqual(await Effect.runPromise(escaped.listInstances), [])
})

test('selected construction retains explicit disable and never reads secret references', async () => {
  const instanceId = ProviderInstanceId.make('disabled-original')
  const entry = Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'codex', enabled: false,
    environment: [{ name: 'LITERAL', value: 'unchanged' },
      { name: 'SECRET', secret: { provider: 'vault', reference: 'op://item/value' } }] })
  let created
  const driver = { driverKind: ProviderDriverKind.make('codex'), configSchema: CodexSettings,
    metadata: { displayName: 'Codex', supportsMultipleInstances: true },
    defaultConfig: () => Schema.decodeSync(CodexSettings)({}),
    create: input => Effect.sync(() => { created = input; return { instanceId } }) }
  await Effect.runPromise(Effect.scoped(SelectedProvider.makeSelectedProviderInstance({ driver, instanceId,
    entry, secrets: { environment: [], config: [] }, managedPolicy: undefined })))
  assert.equal(created.enabled, false)
  assert.deepEqual(created.environment.map(value => value.name), ['LITERAL'])
})

test('original managed policy blocks selected construction before driver creation', async () => {
  const instanceId = ProviderInstanceId.make('policy-blocked')
  const entry = Schema.decodeUnknownSync(ProviderInstanceConfig)({ driver: 'codex', config: {} })
  const managedPolicy = Schema.decodeUnknownSync(ManagedPolicySummary)({ organization: 'Protected Org',
    lockedSettings: [], limits: { providers: { allowedDrivers: ['claudeAgent'] } } })
  let created = 0
  const driver = { driverKind: ProviderDriverKind.make('codex'), configSchema: CodexSettings,
    metadata: { displayName: 'Codex', supportsMultipleInstances: true },
    defaultConfig: () => Schema.decodeSync(CodexSettings)({}),
    create: () => Effect.sync(() => { created++; throw new Error('Blocked driver reached') }) }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const registry = yield* SelectedProvider.makeSelectedProviderInstance({ driver, instanceId, entry,
      managedPolicy, secrets: { environment: [], config: [] } })
    assert.equal(yield* registry.getInstance(instanceId), undefined)
    const unavailable = yield* registry.listUnavailable
    assert.equal(unavailable.length, 1)
    assert.match(JSON.stringify(unavailable), /Protected Org.*does not allow the Codex provider/u)
  })))
  assert.equal(created, 0)
})
