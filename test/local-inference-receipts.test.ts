import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

import { EncryptedLocalInferenceReceiptJournal, LocalInferenceReceiptError } from '../src/local-inference-receipts.js'
import type { LocalInferenceResult } from '@nessie/executor-protocol'

const receipt = (content: string) => ({
  attemptId: '33333333-3333-4333-8333-333333333333',
  dispatchFence: 1,
  result: {
    capability: {
      discoveredAt: '2026-09-20T10:00:00.000Z', model: 'local:latest', provider: 'local_device', source: 'live',
      structuredOutputMode: 'text-only', supportsChat: true, supportsEmbeddings: false, supportsModelDiscovery: true,
      supportsStreaming: true, supportsVision: false, systemPromptMode: 'native', toolCallingMode: 'disabled',
      toolResultMode: 'native-tool-message', usageReporting: {
        cachedInputTokens: false, cachedOutputTokens: false, cacheReadTokens: false, cacheWriteTokens: false,
        inputTokens: true, outputTokens: true, providerReportedCost: false,
      },
    },
    content, finishReason: 'stop', modelDigest: 'a'.repeat(64), remoteHost: null, remoteModel: null,
    toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
  } satisfies LocalInferenceResult,
})

const journal = (now: () => Date) => {
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  return new EncryptedLocalInferenceReceiptJournal({
    read: async () => encrypted,
    remove: async () => { encrypted = undefined },
    write: async (value) => { encrypted = value },
  }, new Uint8Array(32).fill(1), now)
}

test('a receipt is idempotent only for the same result', async () => {
  const store = journal(() => new Date('2026-09-20T10:00:00.000Z'))
  await store.record(receipt('first'))
  await store.record(receipt('first'))
  await assert.rejects(store.record(receipt('changed')), (error: unknown) => (
    error instanceof LocalInferenceReceiptError && error.code === 'receipt_conflict'
  ))
})

test('expired durable receipts are not replayed', async () => {
  let now = new Date('2026-09-20T10:00:00.000Z')
  const store = journal(() => now)
  await store.record(receipt('old result'))
  now = new Date('2026-09-20T11:00:00.000Z')
  assert.equal(await store.get(receipt('old result')), undefined)
})


test('personal results survive TTL, physical cache capacity and process reload until exact ACK', async () => {
  let now = new Date('2026-09-20T10:00:00.000Z')
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const storage = { read: async () => encrypted, write: async (value: NonNullable<typeof encrypted>) => {
    encrypted = value
  }, remove: async () => { encrypted = undefined } }
  const key = new Uint8Array(32).fill(1)
  const store = new EncryptedLocalInferenceReceiptJournal(storage, key, () => now)
  const source = { kind: 'chatgpt' as const, processing: 'openai_cloud' as const,
    billingSource: 'personal_plan' as const, profileId: randomUUID(), accountGeneration: 1, consentRevision: 1 }
  const cloud = Array.from({ length: 9 }, () => ({ ...receipt('provider result'), attemptId: randomUUID(),
    result: { ...receipt('provider result').result, inferenceSource: source,
      capability: { ...receipt('provider result').result.capability, provider: 'executor/chatgpt' as const } } }))
  for (const value of cloud) {
    await store.reservePersonalAttempt({ ...value, inferenceSource: source })
    await store.record(value)
  }
  now = new Date('2026-09-30T10:00:00.000Z')
  const restarted = new EncryptedLocalInferenceReceiptJournal(storage, key, () => now)
  assert.equal((await restarted.pending()).length, 9)
  assert.equal(await restarted.acknowledge({ ...cloud[0]!, result: {
    ...cloud[0]!.result, content: 'different result' } }), false)
  assert.equal((await restarted.pending()).length, 9)
  assert.equal(await restarted.acknowledge(cloud[0]!), true)
  assert.equal((await new EncryptedLocalInferenceReceiptJournal(storage, key, () => now).pending()).length, 8)
})

test('failed protected publication and ACK deletion never create false committed memory state', async () => {
  let failWrite = true, failRemove = true
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const store = new EncryptedLocalInferenceReceiptJournal({ read: async () => encrypted,
    write: async value => { if (failWrite) throw new Error('Unknown protected write'); encrypted = value },
    remove: async () => { if (failRemove) throw new Error('Unknown protected removal'); encrypted = undefined },
  }, new Uint8Array(32).fill(1))
  const original = receipt('original')
  await assert.rejects(store.record(original))
  assert.deepEqual(await store.pending(), [])
  failWrite = false
  await store.record(original)
  await assert.rejects(store.acknowledge(original))
  assert.equal((await store.pending()).length, 1)
  failRemove = false
  assert.equal(await store.acknowledge(original), true)
  assert.deepEqual(await store.pending(), [])
})


test('unknown publication outcome reloads the exact committed result before another mutation', async () => {
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  let unknown = true
  const store = new EncryptedLocalInferenceReceiptJournal({ read: async () => encrypted,
    write: async value => { encrypted = value; if (unknown) { unknown = false; throw new Error('ACK lost') } },
    remove: async () => { encrypted = undefined },
  }, new Uint8Array(32).fill(1))
  const original = receipt('Provider terminal result')
  await assert.rejects(store.record(original))
  assert.equal((await store.pending())[0]?.result.content, original.result.content)
  await assert.rejects(store.record(receipt('Replacement error')), error => error instanceof LocalInferenceReceiptError)
  assert.equal(await store.acknowledge(original), true)
})


test('concurrent personal reservations preserve capacity across restart before provider outcomes', async () => {
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const storage = { read: async () => encrypted, write: async (value: NonNullable<typeof encrypted>) => {
    encrypted = value
  }, remove: async () => { encrypted = undefined } }
  const key = new Uint8Array(32).fill(1)
  const store = new EncryptedLocalInferenceReceiptJournal(storage, key, () => new Date(), { personalCapacity: 4 })
  const source = { kind: 'chatgpt' as const, processing: 'openai_cloud' as const,
    billingSource: 'personal_plan' as const, profileId: randomUUID(), accountGeneration: 1, consentRevision: 1 }
  const ids = Array.from({ length: 5 }, () => randomUUID())
  const reserve = (attemptId: string) => store.reservePersonalAttempt({ attemptId, dispatchFence: 1,
    inferenceSource: source })
  for (const id of ids.slice(0, 3)) await reserve(id)
  const outcomes = await Promise.allSettled(ids.slice(3).map(reserve))
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
  const restart = new EncryptedLocalInferenceReceiptJournal(storage, key, () => new Date(), { personalCapacity: 4 })
  for (const id of ids.slice(0, 3)) assert.equal(await restart.hasPendingAttempt(id), true)
  assert.deepEqual(await restart.pending(), [])
  await assert.rejects(restart.reservePersonalAttempt({ attemptId: randomUUID(), dispatchFence: 1,
    inferenceSource: source }))
})
