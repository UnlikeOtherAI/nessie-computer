import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { createSourceModuleLoader } from '../t3-session-client-connection/module-loader.mjs'
import { sourceFunctions } from '../t3-session-client-connection/source-functions.mjs'
import { readRequestSource, scratch } from './source-fixture.mjs'

const { snapshot, privacy } = await readRequestSource()
const loader = createSourceModuleLoader(snapshot, { dependencyDirectory: resolve(scratch, 'dependencies') })
const Effect = await loader.external('effect/Effect')
const Schema = await loader.external('effect/Schema')
const mcp = await loader.load('packages/contracts/src/orchestratorMcp.ts')
const file = 'apps/server/src/mcp/OrchestratorMcpService.ts'

// Only convert the enclosing object's property delimiter to a standalone declaration.
// The complete pinned requestSecret Effect body executes unchanged, with explicit test ports.
const standalone = { ...snapshot, read: path => {
  const bytes = snapshot.read(path)
  if (path !== file) return bytes
  return Buffer.from(bytes.toString().replace('    requestSecret: Effect.fn(', 'const requestSecret = Effect.fn(')
    .replace('      return { status, secretRef: secretRef.value };\n    }),',
      '      return { status, secretRef: secretRef.value };\n    });'))
} }

test('actual pasted MCP method hands exact decoded bytes to its injected port without recording a card', async () => {
  const canary = ['synthetic', 'pasted', 'C05', '🧭'].join('-')
  const handoffs = []
  const { requestSecret } = sourceFunctions(standalone, file, 'const requestSecret = Effect.fn(',
    '    capabilities: Effect.fn(', ['requestSecret'], {
      Effect,
      loadThreadCaller: () => Effect.succeed({ scope: { thread: { threadId: 't:opaque', providerInstanceId: 'provider' } }, parent: {} }),
      ThreadManagementService: { latestActiveRun: () => ({ rootNodeId: 'node:opaque', providerInstanceId: 'provider' }) },
      requestKey: id => Effect.succeed(id),
      failure: (reason, message) => Effect.fail({ reason, message }),
      secretRequests: { savePasted: handoff => Effect.sync(() => { handoffs.push(handoff); return 'synthetic-transport-file'; }) },
      Metrics: { increment: () => Effect.void, secretRequestsTotal: undefined },
    })
  for (const value of [` ${canary} `, '\r\n', ' ', `\r\n${canary}\n`, '🧭e\u0301']) {
    const input = Schema.decodeUnknownSync(mcp.OrchestratorMcpRequestSecretInput)({
      label: 'Token', reason: 'Required', clientRequestId: '__proto__', value,
    })
    const publicInput = privacy.projectSecretRequestInput('t3-code.request_secret', input)
    assert.equal(JSON.stringify(publicInput).includes(canary), false)
    const result = await Effect.runPromise(requestSecret({ requestNamespace: 'session:opaque' }, input))
    assert.equal(handoffs.at(-1).value, value)
    assert.equal(handoffs.at(-1).requestNamespace, 'session:opaque')
    assert.equal(handoffs.at(-1).requestKey, '__proto__')
    assert.equal(handoffs.at(-1).threadId, 't:opaque')
    assert.equal(JSON.stringify(result).includes(canary), false)
  }
  assert.equal(handoffs.length, 5)
  const before = handoffs.length
  const refusal = await Effect.runPromise(requestSecret({ requestNamespace: 'session:opaque' }, {
    label: 'Token', reason: 'Required', value: canary, delivery: 'secretRef',
  }).pipe(Effect.result))
  assert.equal(refusal._tag, 'Failure')
  assert.equal(handoffs.length, before, 'invalid delivery never reaches the port')
  assert.equal(JSON.stringify(refusal).includes(canary), false)
})
