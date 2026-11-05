import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { LocalInferenceHostTransport } from '../src/local-inference-api.js'
import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import { encodeLocalInferenceFrames } from '../src/local-inference-frames.js'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { EncryptedLocalInferenceReceiptJournal } from '../src/local-inference-receipts.js'
import type { StateSecurityHelper } from '../src/state-security.js'

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

const fixture = async (t: test.TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-poll-reservation-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const mutationStarted = gate()
  const mutationRelease = gate()
  let holdMutation = false
  // Hold the real filesystem mutex at its Windows helper boundary. Privacy
  // is covered by the native suite; this fixture exercises two host owners.
  const helper: StateSecurityHelper = async (command, path) => {
    if (holdMutation && command === 'secure-owner-only-file' && path.includes('control.json.')) {
      mutationStarted.release()
      await mutationRelease.promise
    }
  }
  const security = { platform: 'win32' as const, helper }
  const first = await LocalInferenceCoordinator.open({ directory, security })
  const second = await LocalInferenceCoordinator.open({ directory, security })
  const resourceId = randomUUID()
  await first.syncControl({ resourceId, capacity: 1, controlRevision: 1, paused: false, healthReason: null })
  return {
    first, second, resourceId,
    hold: async () => {
      holdMutation = true
      const pending = second.syncControl({
        resourceId, capacity: 1, controlRevision: 2, paused: false, healthReason: null,
      })
      await mutationStarted.promise
      return { pending, release: mutationRelease.release }
    },
  }
}

const loop = (coordinator: LocalInferenceCoordinator, hostId = randomUUID()) => {
  const polls: Array<{ requestId: string; sequence: number }> = []
  let idleBoundary: (() => Promise<void>) | undefined
  const keys = generateKeyPairSync('ed25519')
  let sequence = 0
  const api: Pick<LocalInferenceHostTransport, 'claim'> = {
    claim: async (poll) => {
      polls.push({ requestId: poll.requestId, sequence: ++sequence })
      await idleBoundary?.()
      return { attempt: null, dispatchFence: null, admission: null }
    },
  }
  const host = new LocalInferenceHostLoop({
    transport: api as LocalInferenceHostTransport, coordinator,
    identity: {
      connectionEpoch: '1', hostId, organizationId: randomUUID(),
      machinePrivateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    },
    isPaused: () => false,
    journal: new EncryptedLocalInferenceReceiptJournal({
      read: async () => undefined,
      remove: async () => undefined,
      write: async () => { throw new Error('An idle poll cannot create a generation receipt.') },
    }, new Uint8Array(32).fill(7)),
    origin: 'http://127.0.0.1:11434',
  })
  return { host, hostId, polls, onIdle: (fn?: () => Promise<void>) => { idleBoundary = fn } }
}

test('idle poll retries its token after a second host holds the Windows coordinator mutation', async (t) => {
  const { first, second, hold } = await fixture(t)
  const firstHost = loop(first)
  const secondHost = loop(second)
  let mutation: Awaited<ReturnType<typeof hold>> | undefined
  firstHost.onIdle(async () => { mutation = await hold() })
  try {
    await assert.rejects(firstHost.host.pollOnce(), /coordinator is busy/)
  } finally {
    mutation?.release()
    await mutation?.pending
  }
  assert.equal(firstHost.polls.length, 1)
  assert.deepEqual(await secondHost.host.pollOnce(), { kind: 'busy' })
  assert.equal(secondHost.polls.length, 0, 'The second host cannot take a still-reserved poll slot.')
  firstHost.onIdle()
  assert.deepEqual(await firstHost.host.pollOnce(), { kind: 'idle' })
  assert.equal(firstHost.polls.length, 2, 'The live first host must retry instead of stranding its reservation.')
  assert.equal(firstHost.polls[1]?.requestId, firstHost.polls[0]?.requestId)
  assert.deepEqual(firstHost.polls.map((poll) => poll.sequence), [1, 2])
  assert.deepEqual(await secondHost.host.pollOnce(), { kind: 'idle' })
  assert.equal(secondHost.polls.length, 1, 'Shared capacity is available after durable idle release.')
})

test('successfully released idle polls use new tokens while another host can poll between them', async (t) => {
  const { first, second } = await fixture(t)
  const firstHost = loop(first)
  const secondHost = loop(second)
  await firstHost.host.pollOnce()
  await secondHost.host.pollOnce()
  await firstHost.host.pollOnce()
  assert.equal(firstHost.polls.length, 2)
  assert.notEqual(firstHost.polls[1]?.requestId, firstHost.polls[0]?.requestId)
  assert.equal(secondHost.polls.length, 1)
})

test('local inference frames preserve Unicode and escaped text within the wire byte limit', () => {
  const text = '\u{1f680}"\\\n'.repeat(4_000)
  const frames = encodeLocalInferenceFrames('output_text.delta', text)
  assert.ok(frames.length > 1)
  const decoded = frames.map((frame) => {
    const payload = Buffer.from(frame, 'base64url')
    assert.ok(payload.byteLength <= 16 * 1024)
    const value = JSON.parse(payload.toString('utf8')) as { type: string; text: string }
    assert.equal(value.type, 'output_text.delta')
    return value.text
  })
  assert.equal(decoded.join(''), text)
})
