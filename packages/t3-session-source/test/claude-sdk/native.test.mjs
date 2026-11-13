import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fixture, user, input, deferred } from './fixture.mjs'
import { patchClaudeSdk } from '../../../../packaging/session-engine/claude-sdk/patch.mjs'

test('real SDK captures exact user encoding before queue, preserving Unicode and client_composed', async () => {
  const { handle, captures, writes, descriptors } = fixture({ verbatimPrompts: true })
  try {
    await handle.ready
    const message = user('Příliš žluťoučký 🦊\n東京')
    const token = handle.capturePrompt(message)
    message.message.content[0].text = 'changed after capture'
    const expected = JSON.stringify({ ...user('Příliš žluťoučký 🦊\n東京'), client_composed: true }) + '\n'
    assert.equal(captures.at(-1), expected)
    assert.equal(Object.isFrozen(token), true)
    assert.equal(Object.isFrozen(descriptors[0].args), true)
    assert.equal(descriptors[0].env.FIXTURE_ENV, 'original')
    assert.equal(descriptors[0].env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts')
    assert.equal('NODE_OPTIONS' in descriptors[0].env, false)
    assert.ok(descriptors[0].args.includes('--input-format'))
    const pumping = handle.streamInput(input(token))
    const frames = []
    for await (const frame of handle.query) frames.push(frame)
    await pumping
    await token.acknowledged
    assert.equal(writes.at(-1), expected)
    assert.equal(frames.find(frame => frame.type === 'system').echo.message.content[0].text,
      'Příliš žluťoučký 🦊\n東京')
  } finally { await handle.close() }
})

test('native acknowledgment gates the next actual SDK write, independently of capture order', async () => {
  const blocked = deferred(), entered = deferred()
  const { handle, writes } = fixture({ beforeWrite: async encoded => {
    if (JSON.parse(encoded).type === 'user') { entered.resolve(); await blocked.promise }
  } })
  try {
    await handle.query.initializationResult()
    const token = handle.capturePrompt(user('first'))
    let acknowledged = false
    void token.acknowledged.then(() => { acknowledged = true })
    const pumping = handle.streamInput(input(token))
    await entered.promise
    const changing = handle.query.setModel('fixture-model')
    assert.equal(acknowledged, false)
    assert.equal(writes.length, 1)
    blocked.resolve()
    await changing
    await token.acknowledged
    assert.deepEqual(writes.map(line => JSON.parse(line).type), ['control_request', 'user', 'control_request'])
    for await (const _frame of handle.query) { /* drain the real parser */ }
    await pumping
  } finally { blocked.resolve(); await handle.close() }
})

test('foreign tokens, replay and bounded captures refuse before another write', async () => {
  const left = fixture(), right = fixture()
  try {
    await Promise.all([left.handle.query.initializationResult(), right.handle.query.initializationResult()])
    const foreign = left.handle.capturePrompt(user('foreign'))
    await assert.rejects(right.handle.streamInput(input(foreign)), /SESSION_CLAUDE_NATIVE_REFUSED/u)
    await assert.rejects(right.handle.close(), /SESSION_CLAUDE_NATIVE_REFUSED/u)
    for (let index = 0; index < 7; index++) left.handle.capturePrompt(user(String(index)))
    assert.throws(() => left.handle.capturePrompt(user('overflow')), /SESSION_CLAUDE_NATIVE_REFUSED/u)
  } finally {
    await Promise.allSettled([left.handle.close(), right.handle.close()])
  }
})

test('replayed tokens refuse after one native write', async () => {
  const { handle, writes } = fixture()
  try {
    await handle.query.initializationResult()
    const token = handle.capturePrompt(user('once'))
    await assert.rejects(handle.streamInput(input(token, token)), /SESSION_CLAUDE_NATIVE_REFUSED/u)
    assert.equal(writes.filter(line => JSON.parse(line).type === 'user').length, 1)
  } finally { await handle.close().catch(() => undefined) }
})

test('abort during startup joins the returned real child and retained clearance', async () => {
  const start = deferred(), clearance = deferred(), observed = deferred(), clearing = deferred()
  const fixtureState = fixture({ beforeStart: async () => { observed.resolve(); await start.promise },
    afterClearance: () => { clearing.resolve(); return clearance.promise } })
  await observed.promise
  fixtureState.parent.abort()
  let closed = false
  const closing = fixtureState.handle.close().catch(() => undefined).then(() => { closed = true })
  start.resolve()
  await clearing.promise
  assert.equal(closed, false)
  clearance.resolve()
  await closing
  assert.equal(fixtureState.terminations(), 1)
})

test('control context is captured before the original initialize callback queue', async () => {
  const blocked = deferred(), entered = deferred()
  const { handle, captures, writes } = fixture({ beforeWrite: async encoded => {
    if (JSON.parse(encoded).request?.subtype === 'initialize') { entered.resolve(); await blocked.promise }
  } })
  try {
    await entered.promise
    const change = handle.query.setModel('queued-model')
    assert.equal(captures.length, 2)
    assert.equal(JSON.parse(captures[1]).request.subtype, 'set_model')
    assert.equal(writes.length, 0)
    blocked.resolve()
    await change
    assert.equal(writes.length, 2)
  } finally { blocked.resolve(); await handle.close() }
})

test('write scheduling follows the original loop rather than prompt capture order', async () => {
  const { handle, captures, writes } = fixture()
  try {
    await handle.query.initializationResult()
    const first = handle.capturePrompt(user('first captured'))
    const second = handle.capturePrompt(user('second captured'))
    const pumping = handle.streamInput(input(second, first))
    await Promise.all([first.acknowledged, second.acknowledged, pumping])
    assert.equal(JSON.parse(captures[1]).message.content[0].text, 'first captured')
    assert.deepEqual(writes.slice(1).map(line => JSON.parse(line).message.content[0].text),
      ['second captured', 'first captured'])
    for await (const _frame of handle.query) { /* drain the real SDK */ }
  } finally { await handle.close() }
})

test('abort joins an uncertain native write and rejects every queued acknowledgment', async () => {
  const entered = deferred(), released = deferred()
  const { handle, parent, writes } = fixture({ beforeWrite: async encoded => {
    if (JSON.parse(encoded).type === 'user') { entered.resolve(); await released.promise }
  } })
  await handle.query.initializationResult()
  const first = handle.capturePrompt(user('blocked')), second = handle.capturePrompt(user('queued'))
  const pumping = handle.streamInput(input(first, second)).catch(() => undefined)
  await entered.promise
  parent.abort()
  let closed = false
  const closing = handle.close().catch(() => undefined).then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  released.resolve()
  await closing
  await pumping
  await assert.rejects(first.acknowledged)
  await assert.rejects(second.acknowledged)
  assert.equal(writes.length, 1)
})

test('native clearance failure remains observable after SDK cleanup', async () => {
  const { handle } = fixture({ afterClearance: () => { throw new Error('fixture clearance failed') } })
  await handle.query.initializationResult()
  await assert.rejects(handle.close(), /fixture clearance failed/u)
  await assert.rejects(handle.close(), /fixture clearance failed/u)
})

test('closure interrupts the actual pending input take and joins its owner cleanup', async () => {
  const waiting = deferred(), taken = deferred(), cleanup = deferred(), interrupted = deferred()
  const { handle, parent } = fixture()
  await handle.query.initializationResult()
  const pumping = handle.streamInput({
    messages: { [Symbol.asyncIterator]: () => ({ next: () => { waiting.resolve(); return taken.promise } }) },
    async interrupt() { interrupted.resolve(); taken.resolve({ done: true }); await cleanup.promise },
  }).catch(() => undefined)
  await waiting.promise
  parent.abort()
  let closed = false
  const closing = handle.close().catch(() => undefined).then(() => { closed = true })
  await interrupted.promise
  assert.equal(closed, false)
  cleanup.resolve()
  await Promise.all([closing, pumping])
})

test('byte limits count encoded UTF8 and the entire retained buffer', async () => {
  for (const total of [false, true]) {
    const { handle } = fixture()
    try {
      await handle.query.initializationResult()
      if (total) {
        handle.capturePrompt(user('ü'.repeat(60_000)))
        handle.capturePrompt(user('ü'.repeat(60_000)))
      }
      assert.throws(() => handle.capturePrompt(user('ü'.repeat(total ? 20_000 : 70_000))),
        /SESSION_CLAUDE_NATIVE_REFUSED/u)
    } finally { await handle.close().catch(() => undefined) }
  }
})

test('explicit executable and supported option owners are required before startup', () => {
  for (const options of [{ pathToClaudeCodeExecutable: undefined }, { env: undefined }, { cwd: undefined },
    { getOAuthToken: async () => 'forbidden' }, { sessionStore: {} }, { spawnClaudeCodeProcess: () => ({}) }]) {
    assert.throws(() => fixture(options), /SESSION_CLAUDE_NATIVE_REFUSED/u)
  }
})

test('stderr is drained without a callback and converts split UTF8 for the original callback', async () => {
  const quiet = fixture({ stderrBytes: 262_144 })
  await quiet.handle.query.initializationResult()
  await quiet.handle.close()
  const chunks = []
  const observed = fixture({ stderr: text => { chunks.push(text) } })
  await observed.handle.query.initializationResult()
  await observed.handle.close()
  assert.ok(chunks.every(text => typeof text === 'string'))
  assert.equal(chunks.join(''), 'Příliš 🦊\n')
})

test('source patch refuses any changed upstream byte', async () => {
  const path = new URL('../../../../packaging/session-engine/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    import.meta.url)
  const bytes = await readFile(path)
  assert.equal(patchClaudeSdk(bytes).edits.length, 7)
  bytes[bytes.length - 1] ^= 1
  assert.throws(() => patchClaudeSdk(bytes), /SESSION_CLAUDE_SDK_SOURCE_MISMATCH/u)
})
