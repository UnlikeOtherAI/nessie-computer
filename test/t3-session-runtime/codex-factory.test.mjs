import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { CodexSettings } from '@nessie/t3-session-source/contracts'
import { makeSessionCodexClientFactory } from '../../dist/t3-session/runtime/codex-factory.js'

test('protected original factory refuses substituted selection and unsupported launch resolution before native', async () => {
  let calls = 0
  const launch = { signal: new AbortController().signal,
    target: { providerInstanceId: 'chosen', threadId: 'thread-original' },
    withProvider: async () => { calls++; throw new Error('fixture must not launch') } }
  const input = { instanceId: 'chosen', threadId: 'thread-original', providerSessionId: 'original-session',
    settings: Schema.decodeUnknownSync(CodexSettings)({ homePath: 'C:\\held-home', binaryPath: 'C:\\codex.exe' }),
    environment: {}, runtimePolicy: {} }
  for (const replacement of [{ instanceId: 'other' }, { threadId: 'other' },
    { settings: { ...input.settings, binaryPath: 'codex' } },
    { settings: { ...input.settings, binaryPath: 'C:\\codex.cmd' } },
    { settings: { ...input.settings, shadowHomePath: 'C:\\overlay' } }]) {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const factory = yield* makeSessionCodexClientFactory(launch)
      return yield* factory.open({ ...input, ...replacement }).pipe(Effect.result)
    })))
    assert.equal(result._tag, 'Failure')
  }
  assert.equal(calls, 0)
})

test('native preparation failure cannot reopen the same original factory', async () => {
  const calls = []
  const launch = { signal: new AbortController().signal,
    target: { providerInstanceId: 'chosen', threadId: 'thread-original' },
    withProvider: async (id, descriptor) => { calls.push({ id, descriptor }); throw new Error('unavailable') } }
  const input = { instanceId: 'chosen', threadId: 'thread-original', providerSessionId: 'original-session',
    settings: Schema.decodeUnknownSync(CodexSettings)({ homePath: 'C:\\held-home', binaryPath: 'C:\\codex.exe' }),
    environment: { EXACT: 'value' }, runtimePolicy: {} }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const factory = yield* makeSessionCodexClientFactory(launch)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* factory.open(input).pipe(Effect.result)
      assert.equal(result._tag, 'Failure')
    }
  })))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'original-session')
  assert.equal(calls[0].descriptor.processPurpose, 'provider')
  assert.equal(calls[0].descriptor.environment.CODEX_HOME, 'C:\\held-home')
  assert.equal(calls[0].descriptor.environment.EXACT, 'value')
  assert.equal(calls[0].descriptor.args[0], 'app-server')
})

test('an escaped original client factory refuses after owner scope closure', async () => {
  let calls = 0
  const launch = { signal: new AbortController().signal,
    target: { providerInstanceId: 'chosen', threadId: 'thread-original' },
    withProvider: async () => { calls++; throw new Error('must not launch') } }
  const factory = await Effect.runPromise(Effect.scoped(makeSessionCodexClientFactory(launch)))
  const result = await Effect.runPromise(Effect.scoped(factory.open({
    instanceId: 'chosen', threadId: 'thread-original', providerSessionId: 'original-session',
    settings: Schema.decodeUnknownSync(CodexSettings)({ homePath: 'C:\\held-home', binaryPath: 'C:\\codex.exe' }),
    environment: {}, runtimePolicy: {},
  }).pipe(Effect.result)))
  assert.equal(result._tag, 'Failure')
  assert.equal(calls, 0)
})
