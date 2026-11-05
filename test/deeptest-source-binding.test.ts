import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Readable, Writable } from 'node:stream'

import { createDeepTestSourceAdapter, serveDeepTestSourceAdapter } from '../src/deeptest-source-adapter.js'
import { parseDeepTestSourceRequest } from '../src/deeptest-source-protocol.js'
import type { ExecutorLocalState } from '../src/state-store.js'

const execFileAsync = promisify(execFile)
const binding = {
  account_id: 'account.binding',
  project_id: 'project.binding',
  review_id: 'review.binding',
  session_id: 'session.binding',
} as const

const frame = (operation: string, fields: Record<string, unknown> = {}) => ({
  ...binding,
  ...fields,
  operation,
  protocol_version: 1,
  request_id: `request_${operation.replace('.', '_')}`,
})

const git = async (root: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  })
  return result.stdout.trim()
}

test('snapshot requires and verifies the settled local root even when another repo has the same commit', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nessie-deeptest-binding-'))
  const selected = join(parent, 'selected')
  const other = join(parent, 'other')
  try {
    await git(parent, ['init', '--quiet', selected])
    await git(selected, ['config', 'user.email', 'fixture@example.test'])
    await git(selected, ['config', 'user.name', 'Fixture'])
    await writeFile(join(selected, 'app.ts'), 'export const selected = true\n')
    await git(selected, ['add', 'app.ts'])
    await git(selected, ['commit', '--quiet', '-m', 'fixture'])
    await execFileAsync('git', ['clone', '--quiet', '--no-local', selected, other])
    const commit = await git(selected, ['rev-parse', 'HEAD'])
    const state = {
      apiBaseUrl: 'https://api.nessie.example',
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        operationKeys: ['file.list', 'file.read'],
        profiles: ['workspace_sandbox'],
        revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      machinePrivateKey: 'private',
      machinePublicKey: 'public',
      workspaceFolders: [{ name: 'workspace', path: selected }],
    } satisfies ExecutorLocalState
    const adapter = createDeepTestSourceAdapter(state)
    await adapter.dispatch(frame('hello'))
    const answer = await adapter.dispatch(frame('source.snapshot', {
      expected_commit: commit,
      expected_source_root: other,
    }))
    assert.equal(answer.status, 'error')
    if (answer.status !== 'error') assert.fail('Expected source root refusal.')
    assert.equal(answer.error.code, 'SOURCE_UNAVAILABLE')
    assert.equal(adapter.snapshotCount(), 0)
    assert.throws(() => parseDeepTestSourceRequest(frame('source.snapshot')), /REQUEST_INVALID/u)
  } finally {
    await rm(parent, { force: true, recursive: true })
  }
})

test('a changed policy revision revokes an open snapshot and clears its bytes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nessie-deeptest-revoke-'))
  const root = join(parent, 'selected')
  try {
    await git(parent, ['init', '--quiet', root])
    await git(root, ['config', 'user.email', 'fixture@example.test'])
    await git(root, ['config', 'user.name', 'Fixture'])
    await writeFile(join(root, 'app.ts'), 'export const selected = true\n')
    await git(root, ['add', 'app.ts'])
    await git(root, ['commit', '--quiet', '-m', 'fixture'])
    const commit = await git(root, ['rev-parse', 'HEAD'])
    const state = {
      apiBaseUrl: 'https://api.nessie.example',
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
        operationKeys: ['file.list', 'file.read'],
        profiles: ['workspace_sandbox'],
        revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      machinePrivateKey: 'private',
      machinePublicKey: 'public',
      workspaceFolders: [{ name: 'workspace', path: root }],
    } satisfies ExecutorLocalState
    let current = state
    const adapter = createDeepTestSourceAdapter(state, async () => current)
    await adapter.dispatch(frame('hello'))
    const opened = await adapter.dispatch(frame('source.snapshot', {
      expected_commit: commit,
      expected_source_root: root,
    }))
    if (opened.status === 'error') assert.fail(opened.error.message)
    assert.equal(adapter.snapshotCount(), 1)
    current = { ...state, descriptor: { ...state.descriptor, operationKeys: [], revision: 2 } }
    const revoked = await adapter.dispatch(frame('source.inventory', {
      snapshot_id: String(opened.result.snapshot_id),
    }))
    assert.equal(revoked.status, 'error')
    if (revoked.status !== 'error') assert.fail('Expected revoked capability.')
    assert.equal(revoked.error.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal(adapter.snapshotCount(), 0)
  } finally {
    await rm(parent, { force: true, recursive: true })
  }
})

test('a closed output breaks backpressure wait so adapter cleanup can finish', async () => {
  const state = {
    apiBaseUrl: 'https://api.nessie.example',
    descriptor: {
      limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65_536, maxSessions: 1 },
      operationKeys: ['file.list', 'file.read'],
      profiles: ['workspace_sandbox'],
      revision: 1,
    },
    executorId: '00000000-0000-4000-8000-000000000005',
    machinePrivateKey: 'private',
    machinePublicKey: 'public',
    workspaceFolders: [{ name: 'workspace', path: process.cwd() }],
  } satisfies ExecutorLocalState
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, _callback) {
      queueMicrotask(() => this.emit('close'))
    },
  })
  await assert.rejects(
    serveDeepTestSourceAdapter(
      state,
      Readable.from([`${JSON.stringify(frame('hello'))}\n`]),
      output,
    ),
    /OUTPUT_CLOSED/u,
  )
})
