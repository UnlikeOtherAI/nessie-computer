import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import test from 'node:test'

import { createDeepTestExecutionAdapter, serveDeepTestExecutionAdapter } from '../src/deeptest-execution-adapter.js'
import { createDeepTestSourceSnapshot } from '../src/deeptest-source-snapshot.js'
import type { ExecutorDeepTestExecutionGrant } from '../src/state-store.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const exec = promisify(execFile)
const binding = { account_id: 'account.test', project_id: 'project.test', review_id: 'review.test', session_id: 'session.test' }
const frame = (operation: string, fields: Record<string, unknown> = {}) => ({ ...binding, ...fields, operation, protocol_version: 1, request_id: `request_${operation.replaceAll('.', '_')}` })

test('revoking a grant stops a blocked command before it can report success', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-adapter-'))
  try {
    await exec('git', ['init', '--quiet', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@example']); await exec('git', ['-C', root, 'config', 'user.name', 'Test']); await writeFile(join(root, 'app.ts'), 'export {}\n'); await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = { browser: { allowedOrigins: ['https://assessment.example'] }, descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 }, operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1 }, executorId: '00000000-0000-4000-8000-000000000005', runtime: { guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime', kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper' }, workspaceFolders: [{ name: 'workspace', path: root }] }
    let current: ExecutorDeepTestExecutionGrant | undefined = grant
    let stopped = false
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const adapter = createDeepTestExecutionAdapter('/state', grant, async () => { if (!current) throw new Error('revoked'); return current }, () => ({ browser: { act: async () => ({}), observe: async () => ({}), open: async () => ({}), stop: async () => false, stopAll: async () => undefined }, command: { run: async () => { markStarted(); return await new Promise((resolve) => setTimeout(() => resolve({ success: true }), 300)) }, stop: async () => { stopped = true; return true }, stopAll: async () => undefined } }))
    await adapter.dispatch(frame('hello'))
    const pending = adapter.dispatch(frame('execution.command.run', { args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest, program: 'true', roe: { allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(), scope: 'test', stop_id: 'stop.test' }, run_id: 'run_test' }))
    await Promise.race([started, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('command did not start')), 2_000))]); current = undefined
    const answer = await pending
    assert.equal(stopped, true)
    assert.equal(answer.status, 'error')
  } finally { await rm(root, { force: true, recursive: true }) }
})

test('stdin EOF closes a running command before it can emit a successful result', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-eof-'))
  try {
    await exec('git', ['init', '--quiet', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@example']); await exec('git', ['-C', root, 'config', 'user.name', 'Test']); await writeFile(join(root, 'app.ts'), 'export {}\n'); await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = { browser: { allowedOrigins: [] }, descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 }, operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1 }, executorId: '00000000-0000-4000-8000-000000000005', runtime: { guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime', kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper' }, workspaceFolders: [{ name: 'workspace', path: root }] }
    let finish!: () => void; let started!: () => void; let stopped = false
    const running = new Promise<Record<string, unknown>>((resolve) => { finish = () => resolve({ success: true }) })
    const startedRun = new Promise<void>((resolve) => { started = resolve })
    const input = new PassThrough(); const output = new PassThrough(); let response = ''
    output.on('data', (chunk) => { response += chunk.toString() })
    const served = serveDeepTestExecutionAdapter('/state', grant, input, output, async () => grant, () => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => false, stopAll: async () => undefined,
      },
      command: {
        run: async () => { started(); return await running },
        stop: async () => { stopped = true; finish(); return true },
        stopAll: async () => { stopped = true; finish() },
      },
    }))
    input.write(`${JSON.stringify(frame('hello'))}\n`)
    input.write(`${JSON.stringify(frame('execution.command.run', { args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest, program: 'true', roe: { allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(), scope: 'test', stop_id: 'stop.test' }, run_id: 'run_test' }))}\n`)
    await Promise.race([startedRun, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('command did not start')), 2_000))])
    input.end(); await served
    assert.equal(stopped, true)
    assert.match(response, /CAPABILITY_UNAVAILABLE/u)
  } finally { await rm(root, { force: true, recursive: true }) }
})

test('a run cannot reuse a guest lease under a different reviewed source snapshot', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-snapshot-pin-'))
  try {
    await exec('git', ['init', '--quiet', root])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await writeFile(join(root, 'app.ts'), 'export const release = 1\n')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'first review'])
    const firstSnapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = {
      browser: { allowedOrigins: [] },
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
        operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      runtime: {
        guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime',
        kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper',
      },
      workspaceFolders: [{ name: 'workspace', path: root }],
    }
    let commandRuns = 0
    const adapter = createDeepTestExecutionAdapter('/state', grant, async () => grant, () => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => false, stopAll: async () => undefined,
      },
      command: {
        run: async () => { commandRuns += 1; return { success: true } },
        stop: async () => false, stopAll: async () => undefined,
      },
    }))
    await adapter.dispatch(frame('hello'))
    const roe = {
      allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(),
      scope: 'test', stop_id: 'stop.test',
    }
    const command = (snapshot: { commit: string; manifest_digest: string }) => frame(
      'execution.command.run', {
        args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest,
        program: 'true', roe, run_id: 'run_test',
      },
    )
    assert.equal((await adapter.dispatch(command(firstSnapshot))).status, 'ok')
    await writeFile(join(root, 'app.ts'), 'export const release = 2\n')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'second review'])
    const secondSnapshot = await createDeepTestSourceSnapshot(root, root)
    const rejected = await adapter.dispatch(command(secondSnapshot))
    assert.equal(rejected.status, 'error')
    assert.equal(rejected.error.code, 'SOURCE_CHANGED')
    assert.equal(commandRuns, 1)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('the execution adapter bounds retained reviewed source snapshots by the session limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-snapshot-limit-'))
  try {
    await exec('git', ['init', '--quiet', root])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await writeFile(join(root, 'app.ts'), 'export {}\n')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = {
      browser: { allowedOrigins: [] },
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
        operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      runtime: {
        guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime',
        kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper',
      },
      workspaceFolders: [{ name: 'workspace', path: root }],
    }
    let commandRuns = 0
    const adapter = createDeepTestExecutionAdapter('/state', grant, async () => grant, () => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => false, stopAll: async () => undefined,
      },
      command: {
        run: async () => { commandRuns += 1; return { success: true } },
        stop: async () => false, stopAll: async () => undefined,
      },
    }))
    await adapter.dispatch(frame('hello'))
    const request = (run_id: string) => frame('execution.command.run', {
      args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest,
      program: 'true', roe: {
        allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(),
        scope: 'test', stop_id: 'stop.test',
      }, run_id,
    })
    assert.equal((await adapter.dispatch(request('run_first'))).status, 'ok')
    const rejected = await adapter.dispatch(request('run_second'))
    assert.equal(rejected.status, 'error')
    assert.equal(rejected.error.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal(commandRuns, 1)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('a failed manager stop keeps a run available for a later release retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-release-retry-'))
  try {
    await exec('git', ['init', '--quiet', root])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await writeFile(join(root, 'app.ts'), 'export {}\n')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = {
      browser: { allowedOrigins: [] },
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
        operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      runtime: {
        guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime',
        kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper',
      },
      workspaceFolders: [{ name: 'workspace', path: root }],
    }
    let failStop = true
    const adapter = createDeepTestExecutionAdapter('/state', grant, async () => grant, () => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => false, stopAll: async () => undefined,
      },
      command: {
        run: async () => ({ success: true }),
        stop: async () => {
          if (failStop) throw new Error('guest stop failed')
          return true
        },
        stopAll: async () => undefined,
      },
    }))
    await adapter.dispatch(frame('hello'))
    const run = frame('execution.command.run', {
      args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest,
      program: 'true', roe: {
        allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(),
        scope: 'test', stop_id: 'stop.test',
      }, run_id: 'run_retry',
    })
    assert.equal((await adapter.dispatch(run)).status, 'ok')
    const release = () => frame('execution.release', { run_id: 'run_retry', stop_id: 'stop.test' })
    const incomplete = await adapter.dispatch(release())
    assert.equal(incomplete.status, 'error')
    assert.equal(incomplete.error.code, 'CAPABILITY_UNAVAILABLE')
    failStop = false
    assert.equal((await adapter.dispatch(release())).status, 'ok')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test('grant revocation during source materialization settles before any guest starts', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-materialization-revoke-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'nessie-execution-materialization-state-'))
  try {
    await exec('git', ['init', '--quiet', root])
    await exec('git', ['-C', root, 'config', 'user.email', 'test@example'])
    await exec('git', ['-C', root, 'config', 'user.name', 'Test'])
    await writeFile(join(root, 'app.ts'), 'export {}\n')
    await exec('git', ['-C', root, 'add', '.'])
    await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = {
      browser: { allowedOrigins: [] },
      descriptor: {
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 },
        operationKeys: ['command.run'], profiles: ['workspace_sandbox'], revision: 1,
      },
      executorId: '00000000-0000-4000-8000-000000000005',
      runtime: {
        guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime',
        kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper',
      },
      workspaceFolders: [{ name: 'workspace', path: root }],
    }
    let current: ExecutorDeepTestExecutionGrant | undefined = grant
    let guestStarted = false
    const adapter = createDeepTestExecutionAdapter(stateDir, grant, async () => {
      if (!current) throw new Error('revoked')
      return current
    }, (_current, _origins, _verifyLease, prepareLeaseSource) => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => false, stopAll: async () => undefined,
      },
      command: {
        run: async (command) => {
          current = undefined
          await prepareLeaseSource?.(command)
          guestStarted = true
          return { success: true }
        },
        stop: async () => true,
        stopAll: async () => undefined,
      },
    }))
    await adapter.dispatch(frame('hello'))
    const response = await Promise.race([
      adapter.dispatch(frame('execution.command.run', {
        args: [], expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest,
        program: 'true', roe: {
          allowed_origins: [], expires_at: new Date(Date.now() + 5_000).toISOString(),
          scope: 'test', stop_id: 'stop.test',
        }, run_id: 'run_revoked_materialization',
      })),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('materialization deadlocked')), 2_000)),
    ])
    assert.equal(response.status, 'error')
    assert.equal(response.error.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal(guestStarted, false)
  } finally {
    await Promise.all([rm(stateDir, { force: true, recursive: true }), rm(root, { force: true, recursive: true })])
  }
})


test('a browser remains watched after a command completes in the same run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-browser-command-watch-'))
  try {
    await exec('git', ['init', '--quiet', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@example']); await exec('git', ['-C', root, 'config', 'user.name', 'Test']); await writeFile(join(root, 'app.ts'), 'export {}\n'); await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = { browser: { allowedOrigins: ['https://assessment.example'] }, descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 }, operationKeys: ['browser.open', 'command.run'], profiles: ['workspace_sandbox'], revision: 1 }, executorId: '00000000-0000-4000-8000-000000000005', runtime: { guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime', kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper' }, workspaceFolders: [{ name: 'workspace', path: root }] }
    let current: ExecutorDeepTestExecutionGrant | undefined = grant; let browserStopped = false
    const adapter = createDeepTestExecutionAdapter('/state', grant, async () => { if (!current) throw new Error('revoked'); return current }, () => ({
      browser: {
        act: async () => ({}), observe: async () => ({}), open: async () => ({}),
        stop: async () => { browserStopped = true; return true }, stopAll: async () => undefined,
      },
      command: { run: async () => ({ success: true }), stop: async () => true, stopAll: async () => undefined },
    }))
    await adapter.dispatch(frame('hello'))
    const roe = { allowed_origins: ['https://assessment.example'], expires_at: new Date(Date.now() + 5_000).toISOString(), scope: 'test', stop_id: 'stop.test' }
    const request = (operation: string, fields: Record<string, unknown>) => frame(operation, { expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest, roe, run_id: 'run_browser_command', ...fields })
    assert.equal((await adapter.dispatch(request('execution.browser.open', { url: 'https://assessment.example' }))).status, 'ok')
    assert.equal((await adapter.dispatch(request('execution.command.run', { args: [], program: 'true' }))).status, 'ok')
    current = undefined
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(browserStopped, true)
  } finally { await rm(root, { force: true, recursive: true }) }
})

test('a thrown browser operation receives a bounded response and does not block the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nessie-execution-serve-browser-failure-'))
  try {
    await exec('git', ['init', '--quiet', root]); await exec('git', ['-C', root, 'config', 'user.email', 'test@example']); await exec('git', ['-C', root, 'config', 'user.name', 'Test']); await writeFile(join(root, 'app.ts'), 'export {}\n'); await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, 'commit', '--quiet', '-m', 'test'])
    const snapshot = await createDeepTestSourceSnapshot(root, root)
    const grant: ExecutorDeepTestExecutionGrant = { browser: { allowedOrigins: ['https://assessment.example'] }, descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 1 }, operationKeys: ['browser.open', 'browser.observe'], profiles: ['workspace_sandbox'], revision: 1 }, executorId: '00000000-0000-4000-8000-000000000005', runtime: { guestInitrdBuilderPath: '/vm/builder', guestRuntimeBundlePath: '/vm/runtime', kernelPath: '/vm/kernel', vmHelperPath: '/vm/helper' }, workspaceFolders: [{ name: 'workspace', path: root }] }
    const input = new PassThrough(); const output = new PassThrough(); const responses: string[] = []
    let flush!: () => void; const flushed = new Promise<void>((resolve) => { flush = resolve })
    output.on('data', (chunk) => { responses.push(...chunk.toString().trim().split('\n').filter(Boolean)); if (responses.length >= 4) flush() })
    const served = serveDeepTestExecutionAdapter('/state', grant, input, output, async () => grant, () => ({
      browser: { act: async () => ({}), observe: async () => { throw new Error('browser broken') }, open: async () => ({}), stop: async () => true, stopAll: async () => undefined },
      command: { run: async () => ({}), stop: async () => true, stopAll: async () => undefined },
    }))
    const roe = { allowed_origins: ['https://assessment.example'], expires_at: new Date(Date.now() + 5_000).toISOString(), scope: 'test', stop_id: 'stop.test' }
    const request = (operation: string, fields: Record<string, unknown>) => frame(operation, { expected_commit: snapshot.commit, expected_manifest_digest: snapshot.manifest_digest, roe, run_id: 'run_serve', ...fields })
    input.write(`${JSON.stringify(frame('hello'))}\n`)
    input.write(`${JSON.stringify(request('execution.browser.open', { url: 'https://assessment.example' }))}\n`)
    input.write(`${JSON.stringify(frame('execution.browser.observe', { include_screenshot: false, run_id: 'run_serve' }))}\n`)
    input.write(`${JSON.stringify({ ...frame('hello'), request_id: 'request_after_browser_failure' })}\n`)
    await flushed; input.end(); await served
    assert.equal(responses.length, 4)
    assert.equal(JSON.parse(responses[2]).error.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal(JSON.parse(responses[3]).status, 'ok')
  } finally { await rm(root, { force: true, recursive: true }) }
})
