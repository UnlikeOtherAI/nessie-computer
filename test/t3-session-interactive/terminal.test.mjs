import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { TerminalOutputProtocol } from '@nessie/t3-session-source/engine'
import { scopedTerminalOutput } from '../../dist/t3-session/interactive/terminal.js'
import { scope, snapshot } from './fixture.mjs'

test('real original terminal stream retains snapshot/output sequence and releases its listener on cancel', async () => {
  let released = 0
  const subscribe = (listen, register) => Effect.gen(function* () {
    const stop = () => { released++ }
    register(stop)
    yield* listen({ type: 'snapshot', snapshot })
    yield* listen({ type: 'output', threadId: scope.threadId, terminalId: 'term:one', sequence: 21, data: 'second' })
    return stop
  })
  const result = await Effect.runPromise(scopedTerminalOutput(scope, 'term:one', subscribe, subscribe)
    .pipe(Stream.take(2), Stream.runCollect))
  assert.deepEqual(Array.from(result).map(event => event.type), ['snapshot', 'output'])
  assert.equal(result[0].snapshot.sequence, 20)
  assert.equal(result[1].sequence, 21)
  assert.equal(released, 1)
})

test('real original overflow path resubscribes to a fresh snapshot and ignores the old listener', async () => {
  let released = 0
  let resumes = 0
  const initial = (listen, register) => Effect.gen(function* () {
    const stop = () => { released++ }
    register(stop)
    for (let i = 0; i < 4; i++) {
      yield* listen({ type: 'output', threadId: scope.threadId, terminalId: 'term:one', sequence: i, data: 'overflow' })
    }
    return stop
  })
  const resume = (listen, register) => Effect.gen(function* () {
    resumes++
    const stop = () => { released++ }
    register(stop)
    yield* listen({ type: 'snapshot', snapshot })
    return stop
  })
  const result = await Effect.runPromise(TerminalOutputProtocol.terminalOutputStream(initial, resume, 16)
    .pipe(Stream.take(1), Stream.runCollect))
  assert.equal(resumes, 1)
  assert.equal(result[0].type, 'snapshot')
  assert.equal(released, 2)
})

test('mismatched native event is rejected before entering the original output queue', async () => {
  let released = 0
  const subscribe = (listen, register) => Effect.gen(function* () {
    const stop = () => { released++ }
    register(stop)
    yield* listen({ type: 'snapshot', snapshot: { ...snapshot, threadId: 'foreign' } })
    return stop
  })
  await assert.rejects(Effect.runPromise(scopedTerminalOutput(scope, 'term:one', subscribe, subscribe)
    .pipe(Stream.take(1), Stream.runCollect)), /resource_mismatch/u)
  assert.equal(released, 1)
})
