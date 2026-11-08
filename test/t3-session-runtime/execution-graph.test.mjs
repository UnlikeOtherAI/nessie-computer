import assert from 'node:assert/strict'
import test from 'node:test'
import * as Effect from 'effect/Effect'
import { HeldSessionExecutionGraph, recognizeSessionExecutionGraph }
  from '../../dist/t3-session/runtime/execution-graph.js'
import { readSessionExecutionResources } from '../../dist/t3-session/runtime/execution-resources.js'
import { sessionExecutionSettingsLayer } from '../../dist/t3-session/runtime/execution-settings.js'
import { Settings } from '@nessie/t3-session-source/engine'

test('serialized graph evidence cannot manufacture the live original graph record', async () => {
  assert.throws(() => new HeldSessionExecutionGraph({}, {}), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  const forged = Object.create(HeldSessionExecutionGraph.prototype)
  assert.throws(() => forged.receipt, /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
  await assert.rejects(Effect.runPromise(recognizeSessionExecutionGraph(forged, {}, {
    requestDigest: 'hmac-sha256:' + 'a'.repeat(64), executionGraph: {},
    provenance: { createdBy: 'user', creationSource: 'web' },
  })), /T3_SESSION_EXECUTION_GRAPH_REFUSED/u)
})

test('caller supplied recheck and settings never substitute for a native issued resource', async () => {
  let decoded = false, checked = false
  const source = {
    get settingsBytes() { decoded = true; return new TextEncoder().encode('{}') },
    receipt: {}, providerReferences: [], signal: new AbortController().signal,
    recheck: async () => { checked = true },
  }
  await assert.rejects(Effect.runPromise(readSessionExecutionResources(source, {})),
    /T3_SESSION_EXECUTION_RESOURCE_REFUSED/u)
  assert.equal(decoded, false)
  assert.equal(checked, false)
})

test('cold settings refuse forged resources without decoding or leaking their configuration', async () => {
  let decoded = false
  const fake = { get settingsBytes() { decoded = true; throw new Error('PRIVATE_CONFIG_VALUE') } }
  await assert.rejects(Effect.runPromise(Settings.ServerSettingsReadService.use(s => s.getSettings).pipe(
    Effect.provide(sessionExecutionSettingsLayer(fake)),
  )), error => !String(error).includes('PRIVATE_CONFIG_VALUE'))
  assert.equal(decoded, false)
})
