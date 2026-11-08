import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as Sink from 'effect/Sink'
import * as Stdio from 'effect/Stdio'
import * as Stream from 'effect/Stream'
import { CodexProtocol } from '@nessie/t3-session-source/engine'

const closedStdio = () => Stdio.make({ args: Effect.succeed([]), stdin: Stream.never,
  stdout: () => Sink.die(new Error('generic stdout must not be used')), stderr: () => Sink.drain })

test('original Codex encoder captures complete bytes before queue and acknowledges only drain', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const captured = yield* Deferred.make(), written = yield* Deferred.make()
    let acknowledged = false, bytes
    const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio: closedStdio(),
      serializedOutput: {
        capture: encoded => Effect.sync(() => { bytes = encoded }).pipe(
          Effect.andThen(Deferred.succeed(captured, undefined)),
          Effect.as(Object.freeze({ write: Deferred.await(written), discard: Effect.void }))),
        refuse: () => Effect.die(new Error('unexpected reply')),
      },
    })
    const sending = yield* protocol.notify('initialized', { text: '日本語' }).pipe(
      Effect.tap(() => Effect.sync(() => { acknowledged = true })), Effect.forkScoped)
    yield* Deferred.await(captured)
    assert.equal(bytes, '{"method":"initialized","params":{"text":"日本語"}}\n')
    assert.equal(acknowledged, false)
    yield* Deferred.succeed(written, undefined)
    yield* Fiber.join(sending)
    assert.equal(acknowledged, true)
  })))
})

test('automatic unsupported response passes only the original protocol ID to native', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ids = []
    const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio: closedStdio(),
      serializedOutput: {
        capture: () => Effect.die(new Error('automatic reply cannot serialize caller JSON')),
        refuse: id => Effect.sync(() => { ids.push(id) }),
      },
    })
    // The protected native receiver separately requires a real outstanding
    // provider request. This fixture checks only the original transport seam.
    yield* protocol.respondError(71, { toProtocolError() { throw new Error('must not evaluate supplied body') } })
    assert.deepEqual(ids, [71])
  })))
})
