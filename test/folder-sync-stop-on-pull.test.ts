import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { EXECUTOR_FOLDER_SYNC_ERROR_CODES as CODES } from '@nessie/executor-protocol'

import { ExecutorApiError } from '../src/api-client.js'
import { startFolderSyncLoop, type FolderSyncLoop } from '../src/folder-sync/engine-loop.js'
import { createSyncHarness } from './support/folder-sync-harness.js'

/**
 * Found by the real-stack rehearsal: Turn off in Nessie reached a live
 * daemon as a 409 DISABLED on its next pull, not on the handshake. The engine
 * treated it as a failure — "folder sync failed: Sync was turned off in
 * Nessie." every backoff — and the console kept showing the old state.
 */
for (const [code, state] of [[CODES.DISABLED, 'off'], [CODES.REAUTHORIZE, 'needs_reauthorization']] as const) {
  test(`an idle long-poll refused with ${code} settles the computer without waiting for a full reconcile`, async (t) => {
    let refuse = false
    const errors: unknown[] = []
    const h = await createSyncHarness({
      wrap: (transport) => ({
        ...transport,
        changes: (...args) => {
          if (args[1]) refuse = true
          return refuse
            ? Promise.reject(new ExecutorApiError('Stopped in Nessie.', { code, status: 409 }))
            : transport.changes(...args)
        },
      }),
    })
    let loop: FolderSyncLoop | null = null
    t.after(async () => { await loop?.stop(); await h.cleanup() })
    await h.enable()
    await h.settle()
    loop = startFolderSyncLoop(h.engine, { watch: false, onError: (error) => errors.push(error) })
    const deadline = Date.now() + 5_000
    while (h.engine.summary()?.state !== state && Date.now() < deadline) await delay(25)
    // Wait for the status write to finish before reading it; repeated Windows
    // file reads can deny the writer's replacement rename.
    await loop.stop()
    loop = null
    const status = await h.state()
    assert.equal(status.state, state)
    if (state === 'off') assert.equal(status.enabled, false)
    assert.deepEqual(errors, [], 'an authority stop is not a retryable daemon failure')
  })

  test(`a pull refused with ${code} stops the pass and the console says ${state}`, async (t) => {
    let refuse = false
    const refusal = () => new ExecutorApiError('Stopped in Nessie.', { code, status: 409 })
    const h = await createSyncHarness({
      wrap: (transport) => ({
        ...transport,
        changes: (...args) => (refuse ? Promise.reject(refusal()) : transport.changes(...args)),
        snapshot: (...args) => (refuse ? Promise.reject(refusal()) : transport.snapshot(...args)),
        report: (...args) => (refuse ? Promise.reject(refusal()) : transport.report(...args)),
      }),
    })
    t.after(h.cleanup)
    h.server.actor.create({ spaceId: h.space.id, parentPageId: null, kind: 'file', title: 'a.txt', content: 'a' })
    await h.enable()
    await h.settle()
    refuse = true
    await h.pass({ scope: null })
    assert.equal((await h.state()).state, state)
    assert.equal(await h.read('Projects/a.txt'), 'a', 'files stay in place')
  })
}

test('turned off in Nessie switches sync off here: no new request until a person turns it on again', async (t) => {
  let refuse = false
  let handshakes = 0
  const h = await createSyncHarness({
    wrap: (transport) => ({
      ...transport,
      handshake: (...args) => { handshakes += 1; return transport.handshake(...args) },
      changes: (...args) => (refuse
        ? Promise.reject(new ExecutorApiError('Off.', { code: CODES.DISABLED, status: 409 })) : transport.changes(...args)),
    }),
  })
  t.after(h.cleanup)
  await h.enable()
  await h.settle()
  refuse = true
  await h.pass({ scope: null })
  const after = handshakes
  await h.pass({ scope: null })
  await h.pass({ scope: null })
  assert.equal(handshakes, after, 'a daemon turned off in Nessie does not ask again by itself')
  const state = await h.state()
  assert.equal(state.enabled, false)
  assert.equal(state.state, 'off')
  refuse = false
  await h.enable()
  await h.pass({ scope: null })
  assert.ok(handshakes > after, 'turning it on here asks Nessie again')
})
