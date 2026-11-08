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
const { CommandId } = await loader.load('packages/contracts/src/index.ts')
const file = 'apps/server/src/orchestration-v2/ThreadLaunchService.ts'
const contents = snapshot.read(file).toString()
const start = '          const messageCommandId ='
const end = '          // A concurrent retry can read no receipt'
assert.equal(contents.split(start).length, 2)
assert.equal(contents.split(end).length, 2)
const fragment = stripTypeScriptTypes(contents.slice(contents.indexOf(start), contents.indexOf(end)),
  { sourceUrl: file })

// Execute the verified original allocation/record/dispatch sequence. The local
// dispatch observes ordering only; it supplies no native or operation authority.
const run = async ({ suppliedId = false, alreadyAccepted = false, reject = false, ordinary = false } = {}) => {
  const calls = []
  const input = { commandId: CommandId.make('original:initial-message:launch'), projectId: 'project',
    initialMessage: { ...(suppliedId ? { messageId: 'supplied-message' } : {}), text: 'original text', attachments: [] },
    modelSelection: { instanceId: 'selected', model: 'original-model' }, createdBy: 'user', creationSource: 'user' }
  const expectedMessage = suppliedId ? 'supplied-message' : 'allocated-message'
  const lineage = ordinary ? undefined : { recordInitialMessage: edge => Effect.suspend(() => {
    calls.push(['record', edge])
    return reject ? Effect.fail(new Error('fixture lineage refusal')) : Effect.void
  }) }
  const threads = { dispatch: command => Effect.sync(() => {
    calls.push(['dispatch', command])
    if (!ordinary) {
      assert.equal(calls.at(-2)[0], 'record')
      assert.deepEqual(calls.at(-2)[1], { parentCommandId: input.commandId,
        commandId: command.commandId, threadId: command.threadId, messageId: command.messageId })
    }
    return { sequence: 42, replayed: alreadyAccepted }
  }) }
  const readReceipt = (_input, id) => Effect.sync(() => {
    calls.push(['receipt', id])
    return alreadyAccepted ? Option.some({ sequence: 42 }) : Option.none()
  })
  const ids = { allocate: { message: selection => Effect.sync(() => {
    calls.push(['allocate', selection]); return expectedMessage
  }) } }
  const mapError = (_input, operation, threadId) => cause => Object.assign(new Error('fixture launch error'),
    { operation, threadId, cause })
  const execute = compileFunction(`return Effect.gen(function* () {
    let messageWasAlreadyAccepted = false;
    ${fragment}
    return { messageCommandId, messageId, dispatched, messageWasAlreadyAccepted };
  });`, ['Effect', 'Option', 'CommandId', 'input', 'threadId', 'lineage', 'threads', 'readReceipt', 'ids',
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
      assert.deepEqual(f.calls.map(call => call[0]), suppliedId
        ? ['receipt', 'record', 'dispatch'] : ['receipt', 'allocate', 'record', 'dispatch'])
      assert.equal(f.calls.at(-1)[1].text, f.input.initialMessage.text)
      assert.equal(f.calls.at(-1)[1].dispatchMode.type, 'defer_start')
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
