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
