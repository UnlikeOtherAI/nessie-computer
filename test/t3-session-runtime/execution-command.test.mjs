import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import * as Effect from 'effect/Effect'
import { withExecutionCommandCapture } from '../../dist/t3-session/source/execution-command.js'
import { makeSessionLaunchCommandLineage } from '../../dist/t3-session/runtime/command-lineage.js'
import { T3ExecutionOriginalCommandEdgeSchema } from '@nessie/executor-protocol'

const data = JSON.parse(await readFile(new URL('./fixtures/original-command-lineage.json', import.meta.url), 'utf8'))
const sha = letter => `sha256:${letter.repeat(64)}`
const generation = pid => ({ pid, startedAt: 'component-start', bootId: 'component-boot' })
const custody = { service: generation(1), controller: generation(2), supervisor: generation(3), runtime: generation(4),
  jobName: `Global\\NessieCustody-${'a'.repeat(64)}`, releaseDigest: 'b'.repeat(64), serviceImageDigest: 'c'.repeat(64) }
const source = { executorId: 'executor', environmentId: 'environment', physicalRootKey: 'source-root' }
const receipt = { evidence: { source }, custody }
// Wire/ordering double only. Native tests separately use actual SQL and file
// objects; no component fixture claims protected graph acceptance or permission.
const graph = { version: 1, nonce: 'd'.repeat(64), sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
  binding: { ...source, sourceRootKey: source.physicalRootKey, sourceGeneration: 'capture',
    threadId: data.thread, providerInstanceId: data.provider, connectionEpoch: 'epoch', runtimeGeneration: 'runtime',
    correlationId: 'correlation', commandId: data.parent, requestSha256: sha('e'), relayHmac: `hmac-sha256:${'f'.repeat(64)}`,
    actorReference: sha('a'), initiationReference: sha('b'), driver: 'codex',
    continuationHomeKey: 'continuation', historyHomeKey: 'history', credentialBindingId: 'credential' },
  targets: [], issuedAtMs: 1000, expiresAtMs: 6000, custody }
delete graph.binding.physicalRootKey
const fixture = override => {
  const calls = [], stop = new AbortController()
  let invalidated = false
  const exchange = input => {
    calls.push(structuredClone(input))
    const changed = override?.(input)
    if (changed !== undefined) return changed
    return input.op === 'executionCommandOpen' ? { opened: true }
      : input.op === 'executionCommandClose' ? { closed: true } : { recorded: true }
  }
  const open = (use, recheck = async () => {}) => withExecutionCommandCapture(exchange, receipt, recheck,
    () => { invalidated = true }, graph, Date.now() + 30_000, stop.signal, use)
  return { open, calls, stop, invalidated: () => invalidated }
}
test('the same original callbacks reach their native capture in actual creation/acceptance order', async () => {
  const f = fixture()
  await f.open(async sink => {
    const lineage = makeSessionLaunchCommandLineage({ commandId: data.parent, threadId: data.thread },
      async () => {}, f.stop.signal, sink)
    try {
      const methods = ['recordInitialMessage', 'recordInitialMessageRun', 'recordPreparedRunRelease', 'recordPreparedRunReleased']
      for (const [index, edge] of data.edges.entries()) {
        const { phase: _phase, ...original } = edge
        await Effect.runPromise(lineage.service[methods[index]](original))
      }
      await Effect.runPromise(lineage.assertProviderTurnStart({ commandId: data.edges[3].commandId, threadId: data.thread,
        request: { type: 'provider-turn.start', runId: data.run } }))
    } finally { lineage.close() }
  })
  assert.deepEqual(f.calls.map(call => call.op), ['executionCommandOpen', ...data.edges.map(() => 'executionCommandRecord'),
    'executionCommandClose'])
  assert.deepEqual(f.calls.filter(call => call.edge).map(call => call.edge), data.edges)
  assert.equal(Object.hasOwn(f.calls[0].graph, 'custody'), false)
  assert.equal(f.calls[0].graph.expiresAtMs, 6000) // Original freshness is not graph retention.
  assert.equal(f.invalidated(), false)
})
test('callback arguments are captured before async recheck and escaped sinks refuse after retirement', async () => {
  const f = fixture(), entered = Promise.withResolvers(), resume = Promise.withResolvers()
  let calls = 0, escaped
  await f.open(async sink => {
    escaped = sink
    const edge = { ...data.edges[0] }
    const pending = sink.record(edge)
    await entered.promise
    edge.commandId = 'retargeted-after-call'
    resume.resolve()
    await pending
  }, async () => { if (++calls === 3) { entered.resolve(); await resume.promise } })
  assert.equal(f.calls.find(call => call.edge).edge.commandId, data.edges[0].commandId)
  await assert.rejects(escaped.record(data.edges[0]), /closed/u)
  assert.equal(f.calls.filter(call => call.op === 'executionCommandClose').length, 1)
})
test('parent cancellation closes native metadata and joins the original pending capture call', async () => {
  const f = fixture(), entered = Promise.withResolvers(), resume = Promise.withResolvers()
  let calls = 0, finished = false
  await assert.rejects(f.open(async sink => {
    const demand = sink.record(data.edges[0])
    const refusal = assert.rejects(demand)
    await entered.promise
    f.stop.abort()
    resume.resolve()
    await refusal
    finished = true
  }, async () => { if (++calls === 3) { entered.resolve(); await resume.promise } }))
  assert.equal(finished, true)
  assert.deepEqual(f.calls.map(call => call.op), ['executionCommandOpen', 'executionCommandClose'])
})
test('unknown edge fields cannot enter the sink, and uncertain retirement invalidates the source', async () => {
  assert.equal(T3ExecutionOriginalCommandEdgeSchema.safeParse({ ...data.edges[0], sql: 'caller assertion' }).success, false)
  const f = fixture(input => input.op === 'executionCommandClose' ? { closed: false } : undefined)
  await assert.rejects(f.open(sink => sink.record({ ...data.edges[0], parentCommandId: { raw: data.parent } })),
    /capture_unavailable/u)
  assert.equal(f.invalidated(), true)
  assert.equal(f.calls.some(call => call.op === 'executionCommandRecord'), false)
})
test('an uncertain open invalidates its source without another attempt or callback', async () => {
  let calls = 0, invalidated = false, invoked = false
  await assert.rejects(withExecutionCommandCapture(() => { calls++; throw new Error('component uncertainty') },
    receipt, async () => {}, () => { invalidated = true }, graph, Date.now() + 30_000, new AbortController().signal,
    async () => { invoked = true }), /capture_unavailable/u)
  assert.equal(calls, 1)
  assert.equal(invalidated, true)
  assert.equal(invoked, false)
})
