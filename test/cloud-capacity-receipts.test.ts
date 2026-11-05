import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CloudCapacityReceipts } from '../src/cloud-capacity-receipts.js'
import type { ChatgptInferenceSource } from '../src/chatgpt-auth-provider.js'

test('stale unknown and concurrent ACKs preserve the authoritative revision', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-cloud-receipts-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  let tail = Promise.resolve()
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const work = tail.then(fn)
    tail = work.then(() => undefined, () => undefined)
    return work
  }
  const source: ChatgptInferenceSource = { kind: 'chatgpt', processing: 'openai_cloud', billingSource: 'personal_plan',
    profileId: randomUUID(), accountGeneration: 1, consentRevision: 1 }
  const store = { mutate,
    barrier: async () => undefined,
    read: async (name: string) => {
      try { return JSON.parse(await readFile(join(directory, name), 'utf8')) as unknown }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    },
    replace: async (name: string, value: unknown) => { await writeFile(join(directory, name), JSON.stringify(value)) },
    remove: async (name: string) => { await unlink(join(directory, name)) },
  }
  const journal = new CloudCapacityReceipts(directory, source, store)
  const owner = randomUUID()
  const identity = { inferenceSource: source, admissionId: randomUUID(), attemptId: randomUUID(),
    resourceId: randomUUID(), fence: randomUUID() }
  await mutate(() => journal.record(owner, { ...identity, confirmed: false }))
  let acknowledge!: () => void
  let submitted!: () => void
  const waiting = new Promise<void>((resolve) => { submitted = resolve })
  const ack = new Promise<void>((resolve) => { acknowledge = resolve })
  const oldFlush = journal.flush(async (receipt) => { assert.equal(receipt.confirmed, false); submitted(); await ack },
    async () => undefined)
  await waiting
  // This is an actual terminal-proof fixture, not a dead-process recovery.
  await mutate(() => journal.record(owner, { ...identity, confirmed: true }))
  await mutate(() => journal.record(owner, { ...identity, confirmed: false }))
  acknowledge()
  await oldFlush
  assert.equal((await journal.pending(owner))?.confirmed, true)
  const revision = JSON.parse(await readFile(join(directory, `termination-${owner}.json`), 'utf8')) as {
    revision: number
  }
  assert.equal(revision.revision, 2)
  await Promise.all([journal.flush(async (receipt) => { assert.equal(receipt.confirmed, true) }, async () => undefined),
    journal.flush(async (receipt) => { assert.equal(receipt.confirmed, true) }, async () => undefined)])
  assert.deepEqual(await readdir(directory), [])
})
