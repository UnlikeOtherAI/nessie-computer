import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { makeSessionCommandLineageRegistry } from '../../dist/t3-session/runtime/command-lineage-registry.js'

const edge = (parentCommandId, threadId = 'thread') => ({ parentCommandId, commandId: `opaque-${parentCommandId}`,
  threadId, messageId: `message-${parentCommandId}` })
const refused = async effect => assert.equal((await Effect.runPromise(Effect.result(effect)))._tag, 'Failure')

test('one source service routes interleaved original commands to distinct reservation owners', async () => {
  const registry = makeSessionCommandLineageRegistry(new AbortController().signal)
  const checks = []
  const first = registry.register({ commandId: 'first', threadId: 'thread' },
    async () => { checks.push('first') }, new AbortController().signal)
  const second = registry.register({ commandId: 'second', threadId: 'other-thread' },
    async () => { checks.push('second') }, new AbortController().signal)
  await Effect.runPromise(registry.service.recordInitialMessage(edge('second', 'other-thread')))
  await Effect.runPromise(registry.service.recordInitialMessage(edge('first')))
  await Effect.runPromise(first.assertInitialMessage('thread'))
  first.close()
  await Effect.runPromise(second.assertInitialMessage('other-thread'))
  await refused(registry.service.recordInitialMessage(edge('first')))
  assert.deepEqual(checks, ['second', 'second', 'first', 'first', 'first', 'first', 'second', 'second'])
  await registry.close()
})

test('unknown commands cannot populate a recorder and retired original parents cannot register again', async () => {
  const registry = makeSessionCommandLineageRegistry(new AbortController().signal)
  const binding = { commandId: 'parent', threadId: 'thread' }
  const first = registry.register(binding, async () => {}, new AbortController().signal)
  await refused(registry.service.recordInitialMessage(edge('unknown')))
  await Effect.runPromise(registry.service.recordInitialMessage(edge('parent')))
  first.close()
  assert.throws(() => registry.register(binding, async () => {}, new AbortController().signal),
    /T3_SESSION_COMMAND_LINEAGE_REFUSED/u)
  await registry.close()
})

test('reservation abort retires only its recorder while source abort revokes every escaped owner', async () => {
  const source = new AbortController(), parent = new AbortController()
  const registry = makeSessionCommandLineageRegistry(source.signal)
  const first = registry.register({ commandId: 'first', threadId: 'thread' }, async () => {}, parent.signal)
  const second = registry.register({ commandId: 'second', threadId: 'thread' },
    async () => {}, new AbortController().signal)
  await Effect.runPromise(registry.service.recordInitialMessage(edge('first')))
  parent.abort()
  await refused(first.assertInitialMessage('thread'))
  assert.throws(() => registry.register({ commandId: 'first', threadId: 'thread' },
    async () => {}, new AbortController().signal), /T3_SESSION_COMMAND_LINEAGE_REFUSED/u)
  await Effect.runPromise(registry.service.recordInitialMessage(edge('second')))
  source.abort()
  await refused(second.assertInitialMessage('thread'))
  await refused(registry.service.recordInitialMessage(edge('second')))
  assert.throws(() => registry.register({ commandId: 'new', threadId: 'thread' },
    async () => {}, new AbortController().signal), /T3_SESSION_COMMAND_LINEAGE_REFUSED/u)
})

const releaseEdge = parentCommandId => ({ parentCommandId, commandId: `independent-release-${parentCommandId}`,
  threadId: 'thread', runId: `run-${parentCommandId}` })
const recordRun = async (registry, parent) => {
  await Effect.runPromise(registry.service.recordInitialMessage(edge(parent)))
  await Effect.runPromise(registry.service.recordInitialMessageRun({ ...edge(parent), runId: `run-${parent}` }))
}

test('release recognition waits for original dispatch success without closing a still-preparing reservation', async () => {
  const registry = makeSessionCommandLineageRegistry(new AbortController().signal)
  const owner = registry.register({ commandId: 'parent', threadId: 'thread' },
    async () => {}, new AbortController().signal)
  await recordRun(registry, 'parent')
  const release = releaseEdge('parent')
  const effect = { commandId: release.commandId, threadId: 'thread',
    request: { type: 'provider-turn.start', runId: release.runId } }
  await Effect.runPromise(registry.service.recordPreparedRunRelease(release))
  await refused(registry.recognizeProviderTurnStart(effect))
  await Effect.runPromise(owner.assertInitialMessage('thread'))
  await Effect.runPromise(registry.service.recordPreparedRunReleased(release))
  assert.equal(await Effect.runPromise(registry.recognizeProviderTurnStart(effect)), owner)
  owner.close()
  await refused(registry.recognizeProviderTurnStart(effect))
  await registry.close()
})

test('the same actual release command cannot be retargeted to a different accepted parent or run', async () => {
  const registry = makeSessionCommandLineageRegistry(new AbortController().signal)
  const first = registry.register({ commandId: 'first', threadId: 'thread' }, async () => {}, new AbortController().signal)
  registry.register({ commandId: 'second', threadId: 'thread' }, async () => {}, new AbortController().signal)
  await recordRun(registry, 'first')
  await recordRun(registry, 'second')
  const release = releaseEdge('first')
  await Effect.runPromise(registry.service.recordPreparedRunRelease(release))
  await refused(registry.service.recordPreparedRunRelease({ ...releaseEdge('second'), commandId: release.commandId }))
  await Effect.runPromise(registry.service.recordPreparedRunReleased(release))
  assert.equal(await Effect.runPromise(registry.recognizeProviderTurnStart({ commandId: release.commandId,
    threadId: 'thread', request: { type: 'provider-turn.start', runId: release.runId } })), first)
  await registry.close()
})
