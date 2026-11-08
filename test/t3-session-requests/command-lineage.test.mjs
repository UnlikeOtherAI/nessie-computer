import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'
import { resolve } from 'node:path'
import test from 'node:test'
import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Effect = await loader.external('effect/Effect')
const Option = await loader.external('effect/Option')
const Schema = await loader.external('effect/Schema')
const { CommandId } = await loader.load('packages/contracts/src/index.ts')
const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
const contents = snapshot.read(file).toString()
const start = '          const messageCommandId ='
const end = '        }\n\n        const projection = yield* threads'
assert.equal(contents.split(start).length, 2)
assert.equal(contents.split(end).length, 2)
const fragment = stripTypeScriptTypes(`function* initialMessageFragment() {
  let messageWasAlreadyAccepted = false;
  let runId = null, messageSequence;
  ${contents.slice(contents.indexOf(start), contents.indexOf(end))}
  return { messageCommandId, messageId, dispatched, messageWasAlreadyAccepted, runId, messageSequence };
}`, { sourceUrl: file })

// Execute the verified original allocation/record/dispatch sequence. The local
// dispatch observes ordering only; it supplies no native or operation authority.
const LaunchError = Schema.TaggedError()('FixtureLaunchError', {
  operation: Schema.String, threadId: Schema.String, cause: Schema.Defect(),
})
const run = async ({ suppliedId = false, alreadyAccepted = false, reject = false, rejectAccepted = false,
  ordinary = false, durableRun = true } = {}) => {
  const calls = []
  const input = { commandId: CommandId.make('original:initial-message:launch'), projectId: 'project',
    initialMessage: { ...(suppliedId ? { messageId: 'supplied-message' } : {}), text: 'original text', attachments: [] },
    modelSelection: { instanceId: 'selected', model: 'original-model' }, createdBy: 'user', creationSource: 'user' }
  const expectedMessage = suppliedId ? 'supplied-message' : 'allocated-message'
  const lineage = ordinary ? undefined : { recordInitialMessage: edge => Effect.suspend(() => {
    calls.push(['record', edge])
    return reject ? Effect.fail(new Error('fixture lineage refusal')) : Effect.void
  }), recordInitialMessageRun: edge => Effect.suspend(() => {
    calls.push(['accepted', edge])
    return rejectAccepted ? Effect.fail(new Error('fixture accepted-run refusal')) : Effect.void
  }) }
  const threads = { dispatch: command => Effect.sync(() => {
    calls.push(['dispatch', command])
    if (!ordinary) {
      assert.equal(calls.at(-2)[0], 'record')
      assert.deepEqual(calls.at(-2)[1], { parentCommandId: input.commandId,
        commandId: command.commandId, threadId: command.threadId, messageId: command.messageId })
    }
    return { sequence: 42, replayed: alreadyAccepted,
      storedEvents: durableRun ? [{ event: { type: 'run.created', payload: { id: 'actual-run' } } }] : [] }
  }) }
  const readReceipt = (_input, id) => Effect.sync(() => {
    calls.push(['receipt', id])
    return alreadyAccepted ? Option.some({ sequence: 42 }) : Option.none()
  })
  const ids = { allocate: { message: selection => Effect.sync(() => {
    calls.push(['allocate', selection]); return expectedMessage
  }) } }
  const mapError = (_input, operation, threadId) => cause => new LaunchError({ operation, threadId, cause })
  const execute = compileFunction(`${fragment}\nreturn Effect.gen(initialMessageFragment);`,
  ['Effect', 'Option', 'CommandId', 'input', 'threadId', 'lineage', 'threads', 'readReceipt', 'ids',
    'mapError', 'workspaceStrategy', 'DispatchModeLimit'], { filename: file })
  const effect = execute(Effect, Option, CommandId, input, 'original-thread', lineage, threads, readReceipt, ids,
    mapError, { type: 'root' }, undefined)
  return { result: await Effect.runPromise(Effect.result(effect)), calls, input, expectedMessage }
}

test('original initial-message edge records actual allocated or supplied IDs before dispatch, including receipt replay',
  async () => {
    for (const suppliedId of [false, true]) for (const alreadyAccepted of [false, true]) {
      const f = await run({ suppliedId, alreadyAccepted })
      assert.equal(f.result._tag, 'Success')
      assert.equal(f.result.success.messageId, f.expectedMessage)
      assert.equal(f.result.success.messageWasAlreadyAccepted, alreadyAccepted)
      assert.equal(f.result.success.runId, 'actual-run')
      assert.deepEqual(f.calls.map(call => call[0]), suppliedId
        ? ['receipt', 'record', 'dispatch', 'accepted'] : ['receipt', 'allocate', 'record', 'dispatch', 'accepted'])
      const dispatched = f.calls.find(call => call[0] === 'dispatch')[1]
      assert.equal(dispatched.text, f.input.initialMessage.text)
      assert.equal(dispatched.dispatchMode.type, 'defer_start')
      assert.deepEqual(f.calls.at(-1)[1], { parentCommandId: f.input.commandId,
        commandId: dispatched.commandId, threadId: dispatched.threadId, messageId: dispatched.messageId, runId: 'actual-run' })
    }
  })

test('original dispatch never runs after lineage refusal and retains the launch error operation', async () => {
  const f = await run({ reject: true })
  assert.equal(f.result._tag, 'Failure')
  assert.equal(f.result.failure.operation, 'dispatch-message')
  assert.equal(f.result.failure.threadId, 'original-thread')
  assert.deepEqual(f.calls.map(call => call[0]), ['receipt', 'allocate', 'record'])
})

test('ordinary original launch retains its dispatch behavior without the protected lineage service', async () => {
  const f = await run({ ordinary: true })
  assert.equal(f.result._tag, 'Success')
  assert.deepEqual(f.calls.map(call => call[0]), ['receipt', 'allocate', 'dispatch'])
})

test('missing durable run and a refused accepted-run observation stop before preparation with original error mapping',
  async () => {
    for (const options of [{ durableRun: false }, { rejectAccepted: true }]) {
      const f = await run(options)
      assert.equal(f.result._tag, 'Failure')
      assert.equal(f.result.failure.operation, 'dispatch-message')
      assert.equal(f.calls.filter(call => call[0] === 'dispatch').length, 1)
      assert.equal(f.calls.filter(call => call[0] === 'accepted').length, options.durableRun === false ? 0 : 1)
    }
  })

const releaseStart = '      yield* setupTracker.markUncancellable(threadId);'
const releaseEnd = '      yield* awaitAsyncSetup;'
assert.equal(contents.split(releaseStart).length, 2)
assert.equal(contents.split(releaseEnd).length, 2)
const releaseFragment = stripTypeScriptTypes(
  contents.slice(contents.indexOf(releaseStart), contents.indexOf(releaseEnd)), { sourceUrl: file })
const runRelease = async ({ ordinary = false, reject = false, refuseDispatch = false } = {}) => {
  const calls = []
  const input = { commandId: CommandId.make('actual-parent:with:unusual:spelling') }
  const record = stage => edge => Effect.suspend(() => {
    calls.push([stage, edge])
    return stage === 'release-created' && reject ? Effect.fail(new Error('fixture release refusal')) : Effect.void
  })
  const lineage = ordinary ? undefined : { recordPreparedRunRelease: record('release-created'),
    recordPreparedRunReleased: record('release-accepted') }
  const setupTracker = { markUncancellable: () => Effect.void, stageStatus: () => Effect.void }
  const threads = { dispatch: command => Effect.suspend(() => {
    calls.push(['dispatch', command])
    return refuseDispatch ? Effect.fail(new Error('fixture dispatch refusal')) : Effect.succeed({ sequence: 45 })
  }) }
  const mapError = (_input, operation, threadId) => cause => new LaunchError({ operation, threadId, cause })
  const execute = compileFunction(`return Effect.gen(function* () {
    let runReleased = false;
    ${releaseFragment}
    return runReleased;
  });`, ['Effect', 'CommandId', 'input', 'threadId', 'runId', 'lineage', 'threads', 'setupTracker', 'mapError'],
  { filename: file })
  return { result: await Effect.runPromise(Effect.result(execute(Effect, CommandId, input, 'actual-thread', 'actual-run',
    lineage, threads, setupTracker, mapError))), calls, input }
}

test('original preparation captures the actual release command before dispatch and acceptance only after success',
  async () => {
    const f = await runRelease()
    assert.equal(f.result._tag, 'Success')
    assert.equal(f.result.success, true)
    assert.deepEqual(f.calls.map(call => call[0]), ['release-created', 'dispatch', 'release-accepted'])
    const command = f.calls[1][1]
    const expected = { parentCommandId: f.input.commandId, commandId: command.commandId,
      threadId: command.threadId, runId: command.runId }
    assert.equal(command.type, 'prepared-run.release')
    assert.deepEqual(f.calls[0][1], expected)
    assert.deepEqual(f.calls[2][1], expected)
  })

test('release observation refusal prevents dispatch; dispatch failure never records accepted release', async () => {
  for (const options of [{ reject: true }, { refuseDispatch: true }]) {
    const f = await runRelease(options)
    assert.equal(f.result._tag, 'Failure')
    assert.equal(f.result.failure.operation, 'release-run')
    assert.deepEqual(f.calls.map(call => call[0]), options.reject ? ['release-created'] : ['release-created', 'dispatch'])
  }
  const ordinary = await runRelease({ ordinary: true })
  assert.equal(ordinary.result._tag, 'Success')
  assert.deepEqual(ordinary.calls.map(call => call[0]), ['dispatch'])
})
