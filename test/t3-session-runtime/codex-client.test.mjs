import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { makeProtectedOriginalCodexClient } from '../../dist/t3-session/runtime/codex-client.js'

// Actual original client, codec queue and parser over transport-only doubles.
// No process, enrolled association or native effect is created by this fixture.
const fixture = associate => {
  const parent = new AbortController(), stdout = new PassThrough(), stderr = new PassThrough(), writes = []
  const provider = { driver: 'codex', signal: parent.signal, associate,
    process: Object.assign(new EventEmitter(), { stdout, stderr, pid: 17, exitCode: null }),
    serialization: { output: { capture: encoded => Effect.sync(() => ({
      write: Effect.sync(() => {
        const request = JSON.parse(encoded)
        writes.push(request)
        stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: 'native-observed-only' } } }) + '\n')
      }), discard: Effect.void,
    })), refuse: () => Effect.die(new Error('unexpected negative reply')) } },
  }
  return { provider, writes, close() { parent.abort(); stdout.destroy(); stderr.destroy() } }
}

test('original Codex thread responses await native association without passing a selected native ID',
  { timeout: 10000 }, async () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    let calls = 0, accepted = false
    const f = fixture(async (...args) => {
      assert.deepEqual(args, []); calls++; entered.resolve(); await release.promise
    })
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const client = yield* makeProtectedOriginalCodexClient(f.provider)
        yield* client.raw.request('model/list', {})
        assert.equal(calls, 0)
        const waiting = yield* client.raw.request(method, {}).pipe(
          Effect.tap(() => Effect.sync(() => { accepted = true })), Effect.forkScoped)
        yield* Effect.promise(() => entered.promise)
        assert.equal(accepted, false)
        release.resolve()
        const response = yield* Fiber.join(waiting)
        assert.equal(response.thread.id, 'native-observed-only')
        assert.equal(accepted, true)
        yield* client.raw.request(method, {})
        assert.equal(calls, 1, 'the same native association handoff is reused, never reissued')
      })))
      assert.deepEqual(f.writes.map(write => write.method), ['model/list', method, method])
    } finally { release.resolve(); f.close() }
  }
})

test('a refused or cancelled association cannot become a successful response or retry', { timeout: 10000 }, async () => {
  for (const mode of ['refused', 'cancelled']) {
    let calls = 0
    const f = fixture(async () => {
      calls++
      if (mode === 'cancelled') f.close()
      else throw new Error('unavailable association')
    })
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const client = yield* makeProtectedOriginalCodexClient(f.provider)
        const first = yield* client.raw.request('thread/start', {}).pipe(Effect.exit)
        assert.equal(first._tag, 'Failure')
        const second = yield* client.raw.request('thread/resume', {}).pipe(Effect.exit)
        assert.equal(second._tag, 'Failure')
        assert.equal(calls, 1)
      })))
    } finally { f.close() }
  }
})
