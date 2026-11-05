/* eslint-disable max-len -- compact closed protocol dispatch keeps request invariants visible. */
import { createHash, randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

import type { ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import { createExecutorBrowserSessionManager, type ExecutorBrowserSessionManager } from './browser-session-manager.js'
import { createExecutorCommandSessionManager, type ExecutorCommandSessionManager } from './command-session-manager.js'
import { assertExecutorEgressOrigin, compileExecutorEgressPolicy } from './egress-policy.js'
import { createDeepTestSourceSnapshot, type DeepTestSourceSnapshot } from './deeptest-source-snapshot.js'
import { materializeDeepTestExecutionSource, verifyDeepTestExecutionSource } from './deeptest-execution-source.js'
import {
  DEEPTEST_EXECUTION_CAPABILITIES,
  DEEPTEST_EXECUTION_PROTOCOL_VERSION,
  bindingFromExecutionRequest,
  parseDeepTestExecutionRequest,
  sameDeepTestExecutionBinding,
  type DeepTestExecutionBinding,
  type DeepTestExecutionErrorCode,
  type DeepTestExecutionRequest,
  type DeepTestExecutionResponse,
  type DeepTestExecutionRoe,
} from './deeptest-execution-protocol.js'
import { guestSessionFolder } from './guest-workspace-lease.js'
import { executorGuestVmExecutionConfig, type ExecutorDeepTestExecutionGrant } from './state-store.js'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
type Managers = { browser: ExecutorBrowserSessionManager; command: ExecutorCommandSessionManager }
type ExpectedSourceSnapshot = { commit: string; manifestDigest: string }

const fail = (request_id: string, code: DeepTestExecutionErrorCode, message: string): DeepTestExecutionResponse => ({ error: { code, message, retryable: false }, protocol_version: 1, request_id, status: 'error' })
const ok = (request_id: string, result: Record<string, unknown>): DeepTestExecutionResponse => ({ protocol_version: 1, request_id, result, status: 'ok' })
const requestId = (value: unknown): string => typeof (value as { request_id?: unknown })?.request_id === 'string' ? (value as { request_id: string }).request_id : 'invalid'
const sameGrant = (left: ExecutorDeepTestExecutionGrant, right: ExecutorDeepTestExecutionGrant): boolean => JSON.stringify(left) === JSON.stringify(right)
const sameExpectedSourceSnapshot = (left: ExpectedSourceSnapshot, right: ExpectedSourceSnapshot): boolean => left.commit === right.commit && left.manifestDigest === right.manifestDigest
const enabledCapabilities = (grant: ExecutorDeepTestExecutionGrant): string[] => {
  const enabled = new Set(grant.descriptor.operationKeys)
  const capabilities = DEEPTEST_EXECUTION_CAPABILITIES.filter((capability) => {
    if (capability === 'execution.release') return enabled.has('command.run') || enabled.has('browser.open')
    return enabled.has(capability.replace('execution.', ''))
  })
  return capabilities
}
const envelope = (grant: ExecutorDeepTestExecutionGrant, runId: string, payload: Record<string, unknown>): ExecutorCommandEnvelope => ({
  argumentDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  bindingFence: '1', bindingId: randomUUID() as ExecutorCommandEnvelope['bindingId'], capabilityRevision: grant.descriptor.revision,
  commandId: randomUUID() as ExecutorCommandEnvelope['commandId'],
  expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  idempotencyKey: `deeptest-${runId}-${randomUUID()}`,
  operationKey: 'command.run',
  payload,
})

export const createDeepTestExecutionAdapter = (
  stateDir: string,
  grant: ExecutorDeepTestExecutionGrant,
  refreshGrant: () => Promise<ExecutorDeepTestExecutionGrant> = async () => grant,
  createManagers: (current: ExecutorDeepTestExecutionGrant, allowedOrigins?: string[], verifyLease?: (lease: { workspace: string }, command: ExecutorCommandEnvelope) => Promise<boolean>, prepareLeaseSource?: (command: ExecutorCommandEnvelope) => Promise<{ release: () => Promise<void>; workspaceRoot: string }>) => Managers = (current, allowedOrigins, verifyLease, prepareLeaseSource) => {
    const config = executorGuestVmExecutionConfig({
      ...current,
      browser: { allowedOrigins: allowedOrigins ?? current.browser.allowedOrigins },
    })
    return { browser: createExecutorBrowserSessionManager(stateDir, config, { prepareLeaseSource, verifyLease }), command: createExecutorCommandSessionManager(stateDir, config, { prepareLeaseSource, verifyLease }) }
  },
) => {
  let binding: DeepTestExecutionBinding | undefined
  let managers!: Managers
  let closed = false
  const roeByRun = new Map<string, DeepTestExecutionRoe>()
  const sourceSnapshotByRun = new Map<string, DeepTestSourceSnapshot>()
  const browserByRun = new Map<string, ExecutorBrowserSessionManager>()
  const lifecycleByRun = new Map<string, { close: () => boolean; revoked: () => boolean }>()
  const stopAll = async (): Promise<void> => { closed = true; await Promise.allSettled([
    managers.command.stopAll(), ...[...browserByRun.values()].map(async (browser) => await browser.stopAll()),
  ]); for (const lifecycle of lifecycleByRun.values()) lifecycle.close(); lifecycleByRun.clear(); browserByRun.clear(); roeByRun.clear(); sourceSnapshotByRun.clear() }
  const revoke = (): void => { void stopAll().catch(() => undefined) }
  const assertGrant = async (): Promise<boolean> => {
    try {
      const current = await refreshGrant()
      if (!sameGrant(current, grant)) { revoke(); return false }
      return true
    } catch { revoke(); return false }
  }
  const verifySnapshot = async (request: Extract<DeepTestExecutionRequest, { expected_commit: string }>): Promise<DeepTestSourceSnapshot | null> => {
    try {
      // Active execution runs inside a guest VM, which mounts one workspace, so
      // this refuses a multi-folder grant for the same reason `command.run`
      // does — it fails closed here, returning null, and the command session
      // manager raises the named refusal.
      const folder = guestSessionFolder(grant.workspaceFolders)
      const snapshot = await createDeepTestSourceSnapshot(folder.path, folder.path, async () => {
        if (!(await assertGrant())) throw new Error('CAPABILITY_UNAVAILABLE')
      })
      // The lease is materialized from the retained reviewed blobs. Only a
      // clean, complete snapshot may supply those immutable bytes.
      return snapshot.coverage.complete && snapshot.working_tree_state === 'clean'
        && snapshot.commit === request.expected_commit
        && snapshot.manifest_digest === request.expected_manifest_digest
        ? snapshot
        : null
    } catch { return null }
  }
  const verifyLease = async (lease: { workspace: string }, command: ExecutorCommandEnvelope): Promise<boolean> => {
    if (
      typeof command.payload.expected_commit !== 'string'
      || typeof command.payload.expected_manifest_digest !== 'string'
    ) return false
    const runId = command.payload.run_id
    const snapshot = typeof runId === 'string' ? sourceSnapshotByRun.get(runId) : undefined
    return snapshot !== undefined
      && snapshot.commit === command.payload.expected_commit
      && snapshot.manifest_digest === command.payload.expected_manifest_digest
      && await verifyDeepTestExecutionSource(lease.workspace, snapshot)
  }
  const prepareLeaseSource = async (command: ExecutorCommandEnvelope) => {
    const runId = command.payload.run_id
    const snapshot = typeof runId === 'string' ? sourceSnapshotByRun.get(runId) : undefined
    if (snapshot === undefined) throw new Error('SOURCE_CHANGED')
    return await materializeDeepTestExecutionSource(stateDir, snapshot, async () => {
      if (!(await assertGrant())) throw new Error('CAPABILITY_UNAVAILABLE')
    })
  }
  managers = createManagers(grant, undefined, verifyLease, prepareLeaseSource)
  const validRoe = (roe: DeepTestExecutionRoe): boolean => Date.parse(roe.expires_at) > Date.now()
    && roe.allowed_origins.every((origin) => grant.browser.allowedOrigins.includes(origin))
  const watchRun = (runId: string, roe: DeepTestExecutionRoe) => {
    lifecycleByRun.get(runId)?.close()
    let revoked = false
    const close = () => { clearInterval(timer); lifecycleByRun.delete(runId); return revoked }
    const lifecycle = { close, revoked: () => revoked }
    const timer = setInterval(() => {
      void (async () => {
        if (!validRoe(roe) || !(await assertGrant())) {
          revoked = true
          close()
          const browser = browserByRun.get(runId)
          browserByRun.delete(runId); roeByRun.delete(runId); sourceSnapshotByRun.delete(runId)
          await Promise.allSettled([managers.command.stop(runId), browser?.stop(runId)])
        }
      })()
    }, 100)
    lifecycleByRun.set(runId, lifecycle)
    return lifecycle
  }
  const dispatch = async (value: unknown): Promise<DeepTestExecutionResponse> => {
    let request: DeepTestExecutionRequest
    try { request = parseDeepTestExecutionRequest(value) } catch { return fail(requestId(value), 'REQUEST_INVALID', 'The native execution request is malformed.') }
    if (closed) return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution child is closing.')
    if (!(await assertGrant())) return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution grant is unavailable.')
    const requested = bindingFromExecutionRequest(request)
    if (request.operation === 'hello') {
      if (binding && !sameDeepTestExecutionBinding(binding, requested)) return fail(request.request_id, 'BINDING_MISMATCH', 'This child is bound to another review.')
      binding = requested
      return ok(request.request_id, { capabilities: enabledCapabilities(grant), executor_id: grant.executorId, protocol_capabilities: DEEPTEST_EXECUTION_CAPABILITIES, protocol_version: DEEPTEST_EXECUTION_PROTOCOL_VERSION })
    }
    if (!binding || !sameDeepTestExecutionBinding(binding, requested)) return fail(request.request_id, 'BINDING_MISMATCH', 'This child is bound to another review.')
    if (request.operation === 'execution.release') {
      const roe = roeByRun.get(request.run_id)
      if (!roe || roe.stop_id !== request.stop_id) return fail(request.request_id, 'RUN_NOT_FOUND', 'The execution run is unavailable.')
      try {
        await Promise.all([browserByRun.get(request.run_id)?.stop(request.run_id), managers.command.stop(request.run_id)])
      } catch {
        return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The local execution cleanup is still pending.')
      }
      lifecycleByRun.get(request.run_id)?.close()
      browserByRun.delete(request.run_id)
      roeByRun.delete(request.run_id)
      sourceSnapshotByRun.delete(request.run_id)
      return ok(request.request_id, { released: true, run_id: request.run_id })
    }
    const requiredOperation = request.operation.replace('execution.', '')
    if (!grant.descriptor.operationKeys.includes(requiredOperation)) {
      return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'This execution capability is not enabled by the local grant.')
    }
    if (request.operation === 'execution.browser.observe' || request.operation === 'execution.browser.act') {
      const roe = roeByRun.get(request.run_id)
      if (!roe) return fail(request.request_id, 'RUN_NOT_FOUND', 'Open an execution browser run first.')
      const browser = browserByRun.get(request.run_id)
      if (!browser) return fail(request.request_id, 'RUN_NOT_FOUND', 'Open an execution browser run first.')
      if (!validRoe(roe)) { await browser.stop(request.run_id); browserByRun.delete(request.run_id); roeByRun.delete(request.run_id); sourceSnapshotByRun.delete(request.run_id); return fail(request.request_id, 'ROE_EXPIRED', 'The run authorization expired.') }
      try {
        const result = request.operation === 'execution.browser.observe'
          ? await browser.observe(envelope(grant, request.run_id, { args: { includeScreenshot: request.include_screenshot } }), request.run_id)
          : await browser.act(envelope(grant, request.run_id, { args: request.action }), request.run_id)
        return ok(request.request_id, result)
      } catch { return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution browser failed locally.') }
    }
    if (!validRoe(request.roe)) return fail(request.request_id, 'ROE_EXPIRED', 'The active-testing authorization expired or exceeds local origin policy.')
    if (!sourceSnapshotByRun.has(request.run_id) && sourceSnapshotByRun.size >= grant.descriptor.limits.maxSessions) {
      return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The local execution run limit is reached.')
    }
    const snapshot = await verifySnapshot(request)
    if (snapshot === null) return fail(request.request_id, 'SOURCE_CHANGED', 'The live workspace no longer matches the reviewed snapshot.')
    const existingRoe = roeByRun.get(request.run_id)
    if (existingRoe && JSON.stringify(existingRoe) !== JSON.stringify(request.roe)) {
      return fail(request.request_id, 'ROE_SCOPE_DENIED', 'A run authorization cannot be replaced.')
    }
    const expectedSnapshot: ExpectedSourceSnapshot = { commit: snapshot.commit, manifestDigest: snapshot.manifest_digest }
    const existingSnapshot = sourceSnapshotByRun.get(request.run_id)
    if (existingSnapshot && !sameExpectedSourceSnapshot({ commit: existingSnapshot.commit, manifestDigest: existingSnapshot.manifest_digest }, expectedSnapshot)) {
      return fail(request.request_id, 'SOURCE_CHANGED', 'A run source snapshot cannot be replaced.')
    }
    roeByRun.set(request.run_id, request.roe)
    sourceSnapshotByRun.set(request.run_id, existingSnapshot ?? snapshot)
    if (request.operation === 'execution.command.run') {
      const priorLifecycle = lifecycleByRun.get(request.run_id)
      const lifecycle = priorLifecycle ?? watchRun(request.run_id, request.roe)
      try {
        const result = await managers.command.run(envelope(grant, request.run_id, {
          args: { args: request.args, ...(request.cwd ? { cwd: request.cwd } : {}), program: request.program },
          expected_commit: request.expected_commit,
          expected_manifest_digest: request.expected_manifest_digest,
          run_id: request.run_id,
        }), request.run_id)
        const revoked = lifecycle.revoked()
        if (!priorLifecycle) lifecycle.close()
        if (closed || revoked) return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution grant was revoked during this run.')
        return ok(request.request_id, result)
      } catch { if (!priorLifecycle) lifecycle.close(); return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution command failed locally.') }
    }
    try { assertExecutorEgressOrigin(request.url, compileExecutorEgressPolicy({ allowedOrigins: request.roe.allowed_origins })) } catch { return fail(request.request_id, 'ROE_SCOPE_DENIED', 'The browser URL is outside the run authorization.') }
    const browser = browserByRun.get(request.run_id) ?? createManagers(grant, request.roe.allowed_origins, verifyLease, prepareLeaseSource).browser
    browserByRun.set(request.run_id, browser)
    const lifecycle = watchRun(request.run_id, request.roe)
    try {
      const result = await browser.open(envelope(grant, request.run_id, {
        args: { url: request.url },
        expected_commit: request.expected_commit,
        expected_manifest_digest: request.expected_manifest_digest,
        run_id: request.run_id,
      }), request.run_id)
      const revoked = lifecycle.close()
      if (closed || revoked) return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution grant was revoked during this run.')
      // A browser keeps running after open. Start a new monitor for its idle
      // subresource activity; it is released only by release/revocation/expiry.
      watchRun(request.run_id, request.roe)
      return ok(request.request_id, result)
    } catch { lifecycle.close(); return fail(request.request_id, 'CAPABILITY_UNAVAILABLE', 'The execution browser failed locally.') }
  }
  return { close: stopAll, dispatch }
}

export const serveDeepTestExecutionAdapter = async (stateDir: string, grant: ExecutorDeepTestExecutionGrant, input: Readable = process.stdin, output: Writable = process.stdout, refreshGrant: () => Promise<ExecutorDeepTestExecutionGrant> = async () => grant, createManagers?: (current: ExecutorDeepTestExecutionGrant, allowedOrigins?: string[]) => Managers): Promise<void> => {
  const adapter = createManagers === undefined ? createDeepTestExecutionAdapter(stateDir, grant, refreshGrant) : createDeepTestExecutionAdapter(stateDir, grant, refreshGrant, createManagers)
  let pending = Buffer.alloc(0)
  const inFlight = new Set<Promise<void>>()
  let dispatchTail = Promise.resolve()
  const dispatch = (value: unknown): void => {
    if (inFlight.size >= 16) {
      output.write(`${JSON.stringify(fail(requestId(value), 'CAPABILITY_UNAVAILABLE', 'Too many queued execution requests.'))}\n`)
      return
    }
    const task = dispatchTail.then(async () => {
      let response: DeepTestExecutionResponse
      try { response = await adapter.dispatch(value) } catch { response = fail(requestId(value), 'CAPABILITY_UNAVAILABLE', 'The local execution adapter failed.') }
      const serialized = JSON.stringify(response)
      output.write(`${Buffer.byteLength(serialized) > MAX_OUTPUT_BYTES ? JSON.stringify(fail(requestId(value), 'CAPABILITY_UNAVAILABLE', 'Execution output exceeds the local limit.')) : serialized}\n`)
    })
    dispatchTail = task.catch(() => undefined)
    inFlight.add(task)
    void task.then(() => inFlight.delete(task), () => inFlight.delete(task))
  }
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, Buffer.from(chunk)])
      let index = pending.indexOf(0x0a)
      while (index >= 0) {
        const line = pending.subarray(0, index); pending = pending.subarray(index + 1)
        if (line.byteLength > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE')
        if (line.byteLength > 0) {
          let value: unknown; try { value = JSON.parse(line.toString('utf8')) } catch { value = null }
          dispatch(value)
        }
        index = pending.indexOf(0x0a)
      }
      if (pending.byteLength > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE')
    }
  } finally {
    await adapter.close()
    await Promise.allSettled(inFlight)
  }
}
