/* eslint-disable max-len -- closed protocol fixtures mirror their JSON frames. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDeepTestExecutionAdapter } from '../src/deeptest-execution-adapter.js'
import { parseDeepTestExecutionRequest } from '../src/deeptest-execution-protocol.js'
import { parseCommand } from '../src/cli-arguments.js'
import type { ExecutorDeepTestExecutionGrant } from '../src/state-store.js'

const binding = { account_id: 'account.test', project_id: 'project.test', review_id: 'review.test', session_id: 'session.test' }
const request = (operation: string, fields: Record<string, unknown> = {}) => ({ ...binding, ...fields, operation, protocol_version: 1, request_id: `request_${operation.replaceAll('.', '_')}` })
const grant: ExecutorDeepTestExecutionGrant = {
  browser: { allowedOrigins: ['https://assessment.example'] },
  descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 4096, maxSessions: 1 }, operationKeys: ['command.run', 'browser.open', 'browser.observe', 'browser.act'], profiles: ['workspace_sandbox'], revision: 1 },
  executorId: '00000000-0000-4000-8000-000000000005',
  runtime: { guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime', kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper' },
  workspaceFolders: [{ name: 'workspace', path: '/workspace' }],
}

test('execution CLI requires an explicit active-testing confirmation', () => {
  assert.deepEqual(parseCommand(['deeptest-execution', '--execution-grant-file', '/private/deeptest-execution-grant.json']), { executionGrantFile: '/private/deeptest-execution-grant.json', kind: 'deeptest-execution' })
  assert.throws(() => parseCommand(['publish-deeptest-execution-grant', '--state-dir', '/private/state']), /Usage/u)
  assert.deepEqual(parseCommand(['publish-deeptest-execution-grant', '--state-dir', '/private/state', '--confirm-active-testing']), { kind: 'publish-deeptest-execution-grant', stateDir: '/private/state' })
})

test('execution protocol closes its schema and pins one review binding', async () => {
  assert.equal(parseDeepTestExecutionRequest(request('hello')).operation, 'hello')
  assert.throws(() => parseDeepTestExecutionRequest({ ...request('hello'), target: 'https://forbidden.example' }), /REQUEST_INVALID/u)
  const command = request('execution.command.run', {
    args: [],
    expected_commit: 'a'.repeat(40),
    expected_manifest_digest: `sha256:${'b'.repeat(64)}`,
    program: 'true',
    roe: { allowed_origins: [], expires_at: '2030-01-01T00:00:00.000Z', scope: 'test', stop_id: 'stop.test' },
    run_id: 'run_test',
  })
  assert.equal(parseDeepTestExecutionRequest(command).operation, 'execution.command.run')
  assert.throws(() => parseDeepTestExecutionRequest({ ...command, expected_manifest_digest: 'b'.repeat(64) }), /REQUEST_INVALID/u)
  const adapter = createDeepTestExecutionAdapter('/state', grant, async () => grant, () => ({
    browser: { act: async () => ({}), observe: async () => ({}), open: async () => ({}), stop: async () => false, stopAll: async () => undefined },
    command: { run: async () => ({}), stop: async () => false, stopAll: async () => undefined },
  }))
  assert.equal((await adapter.dispatch(request('hello'))).status, 'ok')
  const mismatched = await adapter.dispatch({ ...request('hello'), review_id: 'another.review' })
  assert.equal(mismatched.status, 'error')
  if (mismatched.status === 'error') assert.equal(mismatched.error.code, 'BINDING_MISMATCH')
  await adapter.close()
})
