import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { makeSessionLaunchCommandLineage } from '../../dist/t3-session/runtime/command-lineage.js'

const edge = Object.freeze({ parentCommandId: 'launch', commandId: 'opaque-child-without-prefix',
  threadId: 'thread', messageId: 'original-message' })
const fixture = recheck => {
  const stop = new AbortController()
  const owner = makeSessionLaunchCommandLineage({ commandId: 'launch', threadId: 'thread' },
    recheck ?? (async () => {}), stop.signal)
  return { owner, stop, record: next => Effect.runPromise(owner.service.recordInitialMessage(next ?? edge)) }
}
const refused = async effect => assert.equal((await Effect.runPromise(Effect.result(effect)))._tag, 'Failure')
const runEdge = Object.freeze({ ...edge, runId: 'original-run' })
const release = Object.freeze({ parentCommandId: edge.parentCommandId, threadId: edge.threadId,
  runId: runEdge.runId, commandId: 'unrelated-spelling-for-actual-release' })
const startEffect = Object.freeze({ commandId: release.commandId, threadId: edge.threadId,
  request: Object.freeze({ type: 'provider-turn.start', runId: runEdge.runId }) })
const recordRelease = async f => {
  await f.record()
  await Effect.runPromise(f.owner.service.recordInitialMessageRun(runEdge))
  await Effect.runPromise(f.owner.service.recordPreparedRunRelease(release))
  await Effect.runPromise(f.owner.service.recordPreparedRunReleased(release))
}

test('original edge accepts exact replay without deriving child IDs from spelling', async () => {
  let checks = 0
  const f = fixture(async () => { checks++ })
  try {
    await f.record()
    await f.record({ ...edge })
    await Effect.runPromise(f.owner.assertInitialMessage('thread'))
    assert.equal(checks, 6)
  } finally { f.owner.close() }
})

test('substitution of any captured original ID is terminal across subsequent exact replay', async () => {
  for (const key of Object.keys(edge)) {
    const f = fixture()
    await f.record()
    await refused(f.owner.service.recordInitialMessage({ ...edge, [key]: 'replacement' }))
    await refused(f.owner.service.recordInitialMessage(edge))
    await refused(f.owner.assertInitialMessage('thread'))
  }
})

test('missing edge, failed source check, abort and escaped owner all remain refused', async () => {
  for (const mode of ['missing', 'source', 'abort', 'closed']) {
    let sourceCurrent = true
    const f = fixture(async () => { if (!sourceCurrent) throw new Error('synthetic source loss') })
    if (mode !== 'missing') await f.record()
    if (mode === 'source') sourceCurrent = false
    if (mode === 'abort') f.stop.abort()
    if (mode === 'closed') f.owner.close()
    await refused(f.owner.assertInitialMessage('thread'))
    sourceCurrent = true
    await refused(f.owner.service.recordInitialMessage(edge))
  }
})

test('edge is copied before asynchronous source recheck and cannot be retargeted while waiting', async () => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  let checks = 0
  const f = fixture(async () => { if (++checks === 1) { entered.resolve(); await resume.promise } })
  const mutable = { ...edge }
  const work = f.record(mutable)
  await entered.promise
  mutable.commandId = 'replacement'
  resume.resolve()
  await work
  await f.record(edge)
  await Effect.runPromise(f.owner.assertInitialMessage('thread'))
  f.owner.close()
})

test('Effect cancellation during a source check closes the owner before late completion', async () => {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers(), finished = Promise.withResolvers()
  const f = fixture(async () => { entered.resolve(); await resume.promise; finished.resolve() })
  const stop = new AbortController()
  const work = Effect.runPromise(f.owner.service.recordInitialMessage(edge), { signal: stop.signal })
  const interrupted = assert.rejects(work)
  await entered.promise
  stop.abort()
  await interrupted
  resume.resolve()
  await finished.promise
  await refused(f.owner.service.recordInitialMessage(edge))
  await refused(f.owner.assertInitialMessage('thread'))
})

test('accepted initial run and release allow only the original start-effect metadata, with exact replay', async () => {
  const f = fixture()
  try {
    await recordRelease(f)
    await recordRelease(f)
    await Effect.runPromise(f.owner.assertProviderTurnStart(startEffect))
  } finally { f.owner.close() }
})

test('accepted-run substitution cannot replace the original message, command, thread or run', async () => {
  for (const key of Object.keys(runEdge)) {
    const f = fixture()
    await f.record()
    await Effect.runPromise(f.owner.service.recordInitialMessageRun(runEdge))
    await refused(f.owner.service.recordInitialMessageRun({ ...runEdge, [key]: 'replacement' }))
    await refused(f.owner.service.recordInitialMessageRun(runEdge))
  }
})

test('release creation needs the accepted run and release success needs that exact creation', async () => {
  for (const stage of ['missing-run', 'missing-release', 'wrong-run', 'wrong-release']) {
    const f = fixture()
    await f.record()
    if (stage !== 'missing-run') await Effect.runPromise(f.owner.service.recordInitialMessageRun(runEdge))
    if (stage === 'wrong-release') await Effect.runPromise(f.owner.service.recordPreparedRunRelease(release))
    const operation = stage === 'missing-release' || stage === 'wrong-release'
      ? f.owner.service.recordPreparedRunReleased({ ...release,
        ...(stage === 'wrong-release' ? { commandId: 'replacement' } : {}) })
      : f.owner.service.recordPreparedRunRelease({ ...release,
        ...(stage === 'wrong-run' ? { runId: 'replacement' } : {}) })
    await refused(operation)
    await refused(f.owner.service.recordInitialMessageRun(runEdge))
  }
})

test('a start-effect command, thread, run or type substitution is terminal for that reservation', async () => {
  for (const replacement of [{ commandId: edge.commandId }, { threadId: 'other-thread' },
    { request: { type: 'provider-turn.start', runId: 'other-run' } },
    { request: { type: 'provider-turn.restart', runId: runEdge.runId } }]) {
    const f = fixture()
    await recordRelease(f)
    await refused(f.owner.assertProviderTurnStart({ ...startEffect, ...replacement }))
    await refused(f.owner.assertProviderTurnStart(startEffect))
  }
})

test('accepted release metadata cannot survive original source loss or reservation closure', async () => {
  for (const stop of ['source', 'close']) {
    const f = fixture()
    await recordRelease(f)
    if (stop === 'source') f.stop.abort()
    else f.owner.close()
    await refused(f.owner.assertProviderTurnStart(startEffect))
  }
})
