import assert from 'node:assert/strict'
import test from 'node:test'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { sessionOperationScope } from '../../dist/t3-session/runtime/operation-scope.js'

class Writer extends Context.Service()('synthetic:already-built-writer') {}

test('operation scope keeps the exact graph, joins finalizers, and refuses calls after closure', async () => {
  const owner = await Effect.runPromise(Scope.make())
  const identity = { id: 'synthetic:one-writer' }
  const bind = await Effect.runPromise(sessionOperationScope().pipe(
    Effect.provideService(Writer, identity), Effect.provideService(Scope.Scope, owner)))
  let finalized = false
  const result = await Effect.runPromise(bind(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
    return yield* Writer
  })))
  assert.equal(result, identity)
  assert.equal(finalized, true)
  await Effect.runPromise(Scope.close(owner, Exit.void))
  let evaluated = false
  await assert.rejects(Effect.runPromise(bind(Effect.sync(() => { evaluated = true }))),
    /T3_RUNTIME_OPERATION_SCOPE_CLOSED/u)
  assert.equal(evaluated, false)
})

test('caller cancellation and owner closure interrupt joined operations before releasing resources', async () => {
  const owner = await Effect.runPromise(Scope.make())
  const bind = await Effect.runPromise(sessionOperationScope().pipe(Effect.provideService(Scope.Scope, owner)))
  const start = () => {
    const started = Promise.withResolvers()
    let finalized = false
    const controller = new AbortController()
    const result = Effect.runPromise(bind(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true }))
      started.resolve()
      return yield* Effect.never
    })), { signal: controller.signal })
    // Install rejection handling before cancellation so there is no unhandled rejection.
    const stopped = assert.rejects(result)
    return { started: started.promise, controller, stopped, finalized: () => finalized }
  }
  const caller = start()
  await caller.started
  caller.controller.abort()
  await caller.stopped
  assert.equal(caller.finalized(), true)
  const lifetime = start()
  await lifetime.started
  await Effect.runPromise(Scope.close(owner, Exit.void))
  await lifetime.stopped
  assert.equal(lifetime.finalized(), true)
})
