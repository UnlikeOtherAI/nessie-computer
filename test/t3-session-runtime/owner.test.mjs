import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { assertOutsideCheckout } from '../../dist/t3-session/runtime/paths.js'
import { SessionStateOwner } from '../../dist/t3-session/runtime/state-owner.js'
import { withOwnedSessionState } from '../../dist/t3-session/runtime/state.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from '../../dist/state-security.js'

test('real writer acquisitions keep one incarnation, retire it, and mint a different successor', async () => {
  // The coordinator supplies a dedicated, private artifact root outside all
  // checkouts. Never use an executor's durable user-state directory as a fixture.
  const root = process.env.T3_RUNTIME_FIXTURE_ROOT
  assert.ok(root, 'T3_RUNTIME_FIXTURE_ROOT must name an approved private fixture root outside checkouts')
  await assertOutsideCheckout(root)
  await assertOwnerOnlyStatePath(root, 'directory')
  const directory = await mkdtemp(join(root, 'writer-incarnation-'))
  await ensureOwnerOnlyStateDirectory(directory)
  const acquire = () => Effect.runPromise(withOwnedSessionState(directory, Effect.gen(function* () {
    const first = yield* SessionStateOwner
    yield* first.assertCurrent
    assert.equal(yield* SessionStateOwner, first)
    assert.match(first.runtimeGeneration, /^[0-9a-f-]{36}$/u)
    return first
  })))
  const first = await acquire()
  await assert.rejects(Effect.runPromise(first.assertCurrent), /session_state_ownership_lost/u)
  const successor = await acquire()
  assert.notEqual(successor.runtimeGeneration, first.runtimeGeneration)
  await assert.rejects(Effect.runPromise(first.assertCurrent), /session_state_ownership_lost/u)
  await assert.rejects(Effect.runPromise(successor.assertCurrent), /session_state_ownership_lost/u)
  // Preserve this fixture's database and lock for inspection; never unlink the lock.
})
