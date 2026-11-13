import assert from 'node:assert/strict'
import test from 'node:test'
import { assertBrowserClientGraph } from '../../../../packaging/session-engine/client-graph.mjs'

const fixture = () => ({ outputs: {
  'dist/client.js': { entryPoint: 'core/Client.ts', inputs: { 'core/Client.ts': {} },
    imports: [{ path: 'dist/shared.js' }] },
  'dist/shared.js': { inputs: { 'nessie-t3-source:packages/contracts/src/index.ts': {} },
    imports: [{ path: 'effect/Schema', external: true }] },
  'dist/engine.js': { entryPoint: 'core/Engine.ts', inputs: {},
    imports: [{ path: 'node:sqlite', external: true }] },
} })

test('client graph ignores unreachable engine output and follows shared chunks', () => {
  const graph = assertBrowserClientGraph(fixture())
  assert.deepEqual(graph.outputs, ['dist/client.js', 'dist/shared.js'])
  assert.deepEqual(graph.external, ['effect/Schema'])
})

test('client graph rejects a reachable Node, platform, native or engine dependency', () => {
  for (const path of ['node:sqlite', 'crypto', '@effect/platform-node', 'react-native',
    '@nessie/t3-session-source/engine']) {
    const graph = fixture()
    graph.outputs['dist/shared.js'].imports.push({ path, external: true })
    assert.throws(() => assertBrowserClientGraph(graph), /CLIENT_EXTERNAL_REFUSED/u)
  }
  const graph = fixture()
  graph.outputs['dist/shared.js'].inputs['nessie-t3-source:apps/server/src/read.ts'] = {}
  assert.throws(() => assertBrowserClientGraph(graph), /CLIENT_SERVER_SOURCE_REFUSED/u)
})

test('client graph refuses missing outputs and an authored engine chunk', () => {
  const missing = fixture()
  delete missing.outputs['dist/shared.js']
  assert.throws(() => assertBrowserClientGraph(missing), /CLIENT_OUTPUT_MISSING/u)
  const engine = fixture()
  engine.outputs['dist/shared.js'].inputs['core/Engine.ts'] = {}
  assert.throws(() => assertBrowserClientGraph(engine), /CLIENT_AUTHORED_OR_DEPENDENCY_INPUT_REFUSED/u)
  assert.throws(() => assertBrowserClientGraph(engine,
    ['packaging/session-engine/core/Client.ts', 'packaging/session-engine/core/Engine.ts']),
  /CLIENT_AUTHORED_OR_DEPENDENCY_INPUT_REFUSED/u)
})

test('client graph admits only explicitly registered browser host files', () => {
  const graph = fixture()
  const path = 'patches/t3-session/client-connection/browser-thread-host.ts'
  graph.outputs['dist/client.js'].inputs[`../../${path}`] = {}
  assert.throws(() => assertBrowserClientGraph(graph), /CLIENT_AUTHORED_OR_DEPENDENCY_INPUT_REFUSED/u)
  assert.doesNotThrow(() => assertBrowserClientGraph(graph, ['packaging/session-engine/core/Client.ts', path]))
  graph.outputs['dist/client.js'].inputs['../../unregistered/host.ts'] = {}
  assert.throws(() => assertBrowserClientGraph(graph, ['packaging/session-engine/core/Client.ts', path]),
    /CLIENT_AUTHORED_OR_DEPENDENCY_INPUT_REFUSED/u)
})
