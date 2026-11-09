import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as SecureRandom from 'effect/crypto/SecureRandom'
import * as Scope from 'effect/Scope'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { CodexSettings } from '@nessie/t3-session-source/contracts'
import { OriginalClaudeRunner } from '@nessie/t3-session-source/engine'
import { echoOwner, user, deferred } from '../../packages/t3-session-source/test/claude-sdk/fixture.mjs'
import { openProtectedOriginalClaudeQuery } from '../../dist/t3-session/runtime/claude-query.js'
import { makeSessionClaudeQueryRunner } from '../../dist/t3-session/runtime/claude-factory.js'
import { makeSessionCodexClientFactory } from '../../dist/t3-session/runtime/codex-factory.js'
import { makeSessionLaunchCommandLineage } from '../../dist/t3-session/runtime/command-lineage.js'

const input = options => ({ threadId: 'thread-original', providerSessionId: 'provider-original', options: {
  model: 'fixture-model', tools: [], permissionMode: 'default', sessionId: 'fixture-session',
  cwd: process.cwd(), pathToClaudeCodeExecutable: process.execPath, env: { FIXTURE_ENV: 'original' }, ...options,
} })

test('original T3 queue captures SDK bytes/context before offer and notifies only after actual write ACK', async () => {
  const entered = deferred(), release = deferred()
  const state = echoOwner({ beforeWrite: async encoded => {
    if (JSON.parse(encoded).type === 'user') { entered.resolve(); await release.promise }
  } })
  let currentCommand = 'bootstrap', capturedCommand, notified = false
  const originalCapture = state.owner.capture
  state.owner.capture = encoded => {
    if (JSON.parse(encoded).type === 'user') capturedCommand = currentCommand
    return originalCapture(encoded)
  }
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* openProtectedOriginalClaudeQuery(input({ verbatimPrompts: true }),
        state.owner, state.parent.signal)
      currentCommand = 'original-message-command'
      const message = user('Žluťoučký 🦊\n東京')
      const sending = yield* session.offer(message, () => { notified = true }).pipe(Effect.forkScoped)
      yield* Effect.promise(() => entered.promise)
      currentCommand = 'later-command'
      message.message.content[0].text = 'changed after original queue'
      assert.equal(capturedCommand, 'original-message-command')
      assert.equal(notified, false)
      assert.equal(state.writes.length, 1)
      release.resolve()
      yield* Fiber.join(sending)
      assert.equal(notified, true)
      const messages = yield* session.messages.pipe(Stream.take(2), Stream.runCollect)
      assert.equal(Array.from(messages)[0].echo.message.content[0].text, 'Žluťoučký 🦊\n東京')
      assert.equal(JSON.parse(state.writes.at(-1)).client_composed, true)
      yield* session.close
    })))
    assert.equal(state.terminations(), 1)
  } finally { release.resolve(); state.parent.abort() }
})

test('shared original MCP initialization sends credentials over the held encoder, never argv', async () => {
  const state = echoOwner()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const session = yield* openProtectedOriginalClaudeQuery(input({ mcpServers: {
      example: { type: 'http', url: 'http://127.0.0.1/fixture', headers: { Authorization: 'synthetic-only' } },
    } }), state.owner, state.parent.signal)
    assert.ok(state.captures.some(encoded => JSON.parse(encoded).request?.subtype === 'mcp_set_servers'))
    assert.equal(state.descriptors[0].args.join(' ').includes('synthetic-only'), false)
    assert.equal(Object.values(state.descriptors[0].env).includes('synthetic-only'), false)
    yield* session.close
  })))
})

test('original query scope joins a cancelled native write and does not notify or reopen', async () => {
  const entered = deferred(), release = deferred()
  const state = echoOwner({ beforeWrite: async (encoded, signal) => {
    if (JSON.parse(encoded).type === 'user') { entered.resolve(); await release.promise; signal.throwIfAborted() }
  } })
  let escaped, notified = false, finished = false
  const running = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const session = yield* openProtectedOriginalClaudeQuery(input(), state.owner, state.parent.signal)
    escaped = session
    const sending = yield* session.offer(user('cancelled'), () => { notified = true }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => entered.promise)
    state.parent.abort()
    release.resolve()
    yield* Fiber.join(sending)
  }))).catch(() => undefined).finally(() => { finished = true })
  await entered.promise
  assert.equal(finished, false)
  release.resolve()
  await running
  assert.equal(notified, false)
  assert.equal(state.writes.filter(encoded => JSON.parse(encoded).type === 'user').length, 0)
  const result = await Effect.runPromise(escaped.offer(user('late')).pipe(Effect.exit))
  assert.equal(result._tag, 'Failure')
  assert.equal(state.terminations(), 1)
})

test('unbound host callbacks and in-process/stdio MCP refuse before native startup', async () => {
  for (const options of [{ canUseTool: async () => assert.fail('callback executed') }, { hooks: {} },
    { onElicitation: async () => assert.fail('elicitation executed') },
    { mcpServers: { local: { command: 'unadmitted' } } },
    { mcpServers: { local: { type: 'sdk', name: 'unadmitted', instance: {} } } }]) {
    const state = echoOwner()
    const result = await Effect.runPromise(Effect.scoped(openProtectedOriginalClaudeQuery(input(options),
      state.owner, state.parent.signal)).pipe(Effect.result))
    assert.equal(result._tag, 'Failure')
    assert.equal(state.descriptors.length, 0)
    assert.equal(state.captures.length, 0)
  }
})

const deniedHistory = () => Effect.fail(new OriginalClaudeRunner.ClaudeAgentSdkQueryRunnerError({
  method: 'fixture-history-denied', cause: new Error('No history authority in fixture'),
}))
const history = { forkSession: deniedHistory, subagentLaunchToolUseId: deniedHistory, assertComplete: deniedHistory() }
const random = SecureRandom.make(size => globalThis.crypto.getRandomValues(new Uint8Array(size)))

test('original runner rejects wrong source/thread, default home, scripts and escaped scope before native', async () => {
  let calls = 0
  const launch = { signal: new AbortController().signal,
    target: { driver: 'claude', threadId: 'thread-original' },
    withProvider: async () => { calls++; assert.fail('native must not run') } }
  const good = input({ cwd: 'C:\\workspace', pathToClaudeCodeExecutable: 'C:\\claude.exe',
    env: { CLAUDE_CONFIG_DIR: 'C:\\held-home' } })
  for (const change of [{ threadId: 'other' }, { options: { ...good.options, env: {} } },
    { options: { ...good.options, pathToClaudeCodeExecutable: 'claude' } },
    { options: { ...good.options, pathToClaudeCodeExecutable: 'C:\\claude.cmd' } }]) {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const runner = yield* makeSessionClaudeQueryRunner(launch, history)
      return yield* runner.open({ ...good, ...change }).pipe(Effect.result)
    })).pipe(Effect.provideService(SecureRandom.SecureRandom, random)))
    assert.equal(result._tag, 'Failure')
  }
  const escaped = await Effect.runPromise(Effect.scoped(makeSessionClaudeQueryRunner(launch, history))
    .pipe(Effect.provideService(SecureRandom.SecureRandom, random)))
  assert.equal((await Effect.runPromise(escaped.open(good).pipe(Effect.result)))._tag, 'Failure')
  assert.equal(calls, 0)
})

test('failed native preparation uses the original allocated provider ID once, without a launcher retry', async () => {
  const signal = new AbortController().signal, seen = [], attempts = []
  const commandLineage = makeSessionLaunchCommandLineage({ commandId: 'launch', threadId: 'thread-original' },
    async () => {}, signal)
  await Effect.runPromise(commandLineage.service.recordInitialMessage({ parentCommandId: 'launch',
    commandId: 'original-message', threadId: 'thread-original', messageId: 'message' }))
  const launch = { signal, commandLineage, target: { driver: 'claude', threadId: 'thread-original' },
    withProvider: async (id, descriptor) => { seen.push({ id, descriptor }); throw new Error('fixture unavailable') } }
  const final = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runner = yield* makeSessionClaudeQueryRunner(launch, history)
    const selected = input({ cwd: 'C:\\workspace', pathToClaudeCodeExecutable: 'C:\\claude.exe',
      env: { CLAUDE_CONFIG_DIR: 'C:\\held-home' } })
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* runner.open(selected).pipe(Effect.exit)
      attempts.push(result._tag)
      assert.equal(result._tag, 'Failure')
    }
  })).pipe(Effect.exit, Effect.provideService(SecureRandom.SecureRandom, random)))
  assert.equal(final._tag, 'Failure') // The original failed native work remains retained at scope close.
  assert.deepEqual(attempts, ['Failure', 'Failure'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].id, 'provider-original')
  assert.equal(seen[0].descriptor.command, 'C:\\claude.exe')
  assert.equal(seen[0].descriptor.environment.CLAUDE_CONFIG_DIR, 'C:\\held-home')
  assert.ok(seen[0].descriptor.args.includes('--session-id=fixture-session'))
  commandLineage.close()
})

test('both original factories reject an ancestor scope as soon as closing starts, before child cleanup drains', async () => {
  for (const driver of ['codex', 'claude']) {
    const parent = await Effect.runPromise(Scope.make('sequential'))
    const child = await Effect.runPromise(Scope.fork(parent, 'sequential'))
    const entered = deferred(), release = deferred(), signal = new AbortController().signal
    const commandLineage = makeSessionLaunchCommandLineage({ commandId: 'launch', threadId: 'thread-original' },
      async () => {}, signal)
    await Effect.runPromise(commandLineage.service.recordInitialMessage({ parentCommandId: 'launch',
      commandId: 'original-message', threadId: 'thread-original', messageId: 'message' }))
    let calls = 0
    const launch = { signal, commandLineage, target: { driver, threadId: 'thread-original', providerInstanceId: 'chosen' },
      withProvider: async () => { calls++; throw new Error('scope must reject before native') } }
    const factory = await Effect.runPromise((driver === 'claude'
      ? makeSessionClaudeQueryRunner(launch, history) : makeSessionCodexClientFactory(launch)).pipe(
      Effect.provideService(Scope.Scope, child), Effect.provideService(SecureRandom.SecureRandom, random)))
    await Effect.runPromise(Scope.addFinalizer(parent, Effect.promise(async () => {
      entered.resolve(); await release.promise
    })))
    const closing = Effect.runPromise(Scope.close(parent, Exit.void))
    try {
      await entered.promise
      assert.equal(parent.state._tag, 'Closed')
      assert.notEqual(child.state._tag, 'Closed')
      const selected = driver === 'claude'
        ? input({ cwd: 'C:\\workspace', pathToClaudeCodeExecutable: 'C:\\claude.exe',
          env: { CLAUDE_CONFIG_DIR: 'C:\\held-home' } })
        : { instanceId: 'chosen', threadId: 'thread-original', providerSessionId: 'original-session',
          settings: Schema.decodeUnknownSync(CodexSettings)({ homePath: 'C:\\held-home', binaryPath: 'C:\\codex.exe' }),
          environment: {}, runtimePolicy: {} }
      const result = await Effect.runPromise(factory.open(selected).pipe(Effect.exit,
        Effect.provideService(Scope.Scope, child)))
      assert.equal(result._tag, 'Failure')
      assert.equal(calls, 0)
    } finally { release.resolve(); await closing; commandLineage.close() }
  }
})
