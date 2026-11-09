import assert from 'node:assert/strict'
import { test } from 'node:test'
import { T3ExecutionResourceReceiptSchema, T3_EXECUTION_SETTINGS_LIMIT } from '@nessie/executor-protocol'
import { recognizeT3ExecutionResource, type T3ExecutionResourceScope } from '../src/t3-session/source/execution.js'

const generation = { pid: 42, startedAt: 'actual-generation-required', bootId: 'test-codec-only' }
const receipt = () => ({ version: 1, resourceId: 'a'.repeat(64), resourceGeneration: `sha256:${'b'.repeat(64)}`,
  evidence: { source: { executorId: 'executor', admittedRootKey: 'configured', physicalRootKey: `windows-file-id:${'c'.repeat(64)}`,
    environmentId: 'original:雪', databaseIdentity: 'volume:db', environmentIdentity: 'volume:env',
    layout: 'v2-80', databaseRole: 'authoritative-v2' }, settingsIdentity: 'volume:settings', settingsDigest: 'd'.repeat(64),
  settingsLength: 2, providerReferences: [{ referenceId: 'e'.repeat(64), instanceId: 'original-instance', driver: 'codex',
    role: 'history', identity: 'volume:home' }] },
  custody: { service: generation, controller: generation, supervisor: generation, runtime: generation,
    jobName: `Global\\NessieCustody-${'f'.repeat(64)}`, releaseDigest: 'a'.repeat(64), serviceImageDigest: 'b'.repeat(64) } })

test('execution resource codec preserves original IDs and accepts no paths, settings or credential DTO', () => {
  assert.deepEqual(T3ExecutionResourceReceiptSchema.parse(receipt()), receipt())
  for (const patch of [{ settingsBytes: '{}' }, { owner: true }, { credential: 'secret' }, { resourceId: 'path' }]) {
    assert.equal(T3ExecutionResourceReceiptSchema.safeParse({ ...receipt(), ...patch }).success, false)
  }
  for (const settingsLength of [0, T3_EXECUTION_SETTINGS_LIMIT + 1, 1.5]) {
    const value = receipt(); value.evidence.settingsLength = settingsLength
    assert.equal(T3ExecutionResourceReceiptSchema.safeParse(value).success, false)
  }
  const duplicate = receipt()
  duplicate.evidence.providerReferences.push({ ...duplicate.evidence.providerReferences[0]! })
  assert.equal(T3ExecutionResourceReceiptSchema.safeParse(duplicate).success, false)
  const wrongRole = receipt(); wrongRole.evidence.source.databaseRole = 'sole-legacy'
  assert.equal(T3ExecutionResourceReceiptSchema.safeParse(wrongRole).success, false)
})

test('parsed receipt and arbitrary successful recheck cannot mint protected callback scope', async () => {
  let calls = 0
  const parsed = T3ExecutionResourceReceiptSchema.parse(receipt())
  const forged = { receipt: parsed, settingsBytes: new Uint8Array(), providerReferences: [],
    signal: new AbortController().signal, recheck: async () => { calls += 1 },
    withReadonlySourceSnapshot: async () => { throw new Error('unissued source snapshot') },
  } satisfies T3ExecutionResourceScope
  await assert.rejects(recognizeT3ExecutionResource(forged), /not_issued/u)
  assert.equal(calls, 0)
})
