import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ExecutorCodingSessionAuthoritySchema, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { managedSessionEvidence, requireManagedSessionEvidence } from '../src/coding-session/session-authority.js'
import { executorSessionCommandArgumentProjection, executorCodingSessionResultScope } from '@nessie/executor-protocol'
import { validateScopedCodingResult } from '../src/coding-session/session-result-authority.js'
import { publishExecutorMcpResult } from '../src/mcp-result-publication.js'

const scope = (): ExecutorCodingSessionAuthority => ({ version: 1, executorId: randomUUID(),
  originalOwnerGeneration: randomUUID(), ownerKey: `sha256:${'a'.repeat(64)}`, commandId: randomUUID(),
  operation: 'session_list', purpose: 'read', issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 25_000).toISOString(), connectionEpoch: '1', authorizationRevision: 1,
  filter: {}, admissions: [] })

test('session wire is strict, bounded, operation-specific and separates read from control', () => {
  const base = scope()
  assert.ok(ExecutorCodingSessionAuthoritySchema.safeParse(base).success)
  for (const patch of [{ purpose: 'control' }, { daemonControl: true }, { operation: 'session_queue' },
    { expiresAt: new Date(Date.now() + 60_000).toISOString() }, { operation: 'session_status' }]) {
    assert.equal(ExecutorCodingSessionAuthoritySchema.safeParse({ ...base, ...patch }).success, false)
  }
})

test('duplicate, conflicting and oversized session selections cannot authorize a list', () => {
  const base = scope()
  const evidence = managedSessionEvidence({ executorId: base.executorId,
    originalOwnerGeneration: base.originalOwnerGeneration, startCommandId: randomUUID() }, randomUUID(), base.ownerKey)
  for (const admissions of [[evidence, evidence], [{ ...evidence, originalOwnerGeneration: randomUUID() }],
    Array.from({ length: 33 }, () => ({ ...evidence, sessionId: randomUUID() }))]) {
    assert.equal(ExecutorCodingSessionAuthoritySchema.safeParse({ ...base, admissions }).success, false)
  }
})

test('a digest and matching namespace do not adopt a legacy row without independently persisted actual start', () => {
  const base = scope(), sessionId = randomUUID()
  const start = { executorId: base.executorId, originalOwnerGeneration: base.originalOwnerGeneration,
    startCommandId: randomUUID() }
  const evidence = managedSessionEvidence(start, sessionId, base.ownerKey)
  const authority = { ...base, operation: 'session_status' as const, admissions: [evidence] }
  assert.throws(() => requireManagedSessionEvidence(authority, { sessionId, ownerKey: base.ownerKey }))
  assert.throws(() => requireManagedSessionEvidence(authority, { sessionId, ownerKey: base.ownerKey,
    originalManagedStart: { ...start, originalOwnerGeneration: randomUUID() } }))
  assert.throws(() => requireManagedSessionEvidence(authority, { sessionId: randomUUID(), ownerKey: base.ownerKey,
    originalManagedStart: start }))
  assert.throws(() => requireManagedSessionEvidence({ ...authority,
    expiresAt: new Date(Date.now() - 1).toISOString() }, { sessionId, ownerKey: base.ownerKey,
    originalManagedStart: start }))
})

test('command projection excludes only validated lease dates and retains arguments and every semantic scope field', () => {
  const authority = scope()
  const payload = { args: { tool: 'session_list', arguments: { search: 'original' } }, owner: { actorUserId: randomUUID() },
    codingSessionAuthority: authority }
  const projected = executorSessionCommandArgumentProjection(payload)
  assert.deepEqual(executorSessionCommandArgumentProjection({ ...payload, codingSessionAuthority: { ...authority,
    issuedAt: new Date(Date.now() + 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 26_000).toISOString() } }), projected)
  for (const patch of [{ ownerKey: `sha256:${'b'.repeat(64)}` }, { originalOwnerGeneration: randomUUID() },
    { filter: { search: 'changed' } }, { nextCursor: 'changed' }, { authorizationRevision: 2 }, { connectionEpoch: '2' }]) {
    assert.notDeepEqual(executorSessionCommandArgumentProjection({ ...payload,
      codingSessionAuthority: { ...authority, ...patch } }), projected)
  }
  assert.notDeepEqual(executorSessionCommandArgumentProjection({ ...payload, args: {} }), projected)
  const invalid = { ...payload, codingSessionAuthority: { ...authority, unexpected: true } }
  assert.equal(executorSessionCommandArgumentProjection(invalid), invalid, 'invalid authority cannot shed any fields')
})

test('unselected results, sidecars and unscoped errors are withheld before publication', async () => {
  const authority = scope(), resultScope = executorCodingSessionResultScope(authority)
  const valid = { content: [{ type: 'text', text: JSON.stringify({ resultScope, sessions: [] }) }] }
  assert.deepEqual(validateScopedCodingResult(valid, authority), valid)
  assert.deepEqual(validateScopedCodingResult({ ...valid, structuredContent: { secret: 'private side channel' },
    _meta: { history: 'private side channel' } }, authority), valid)
  for (const raw of [
    { content: [{ type: 'text', text: JSON.stringify({ resultScope, sessions: [{ sessionId: randomUUID() }] }) }] },
    { ...valid, content: [...valid.content, { type: 'image', data: 'forbidden', mimeType: 'image/png' }] },
    { isError: true, content: [{ type: 'text', text: 'unscoped private failure' }] },
  ]) {
    const published = await publishExecutorMcpResult(raw, { server: 'coding-sessions', tool: 'session_list',
      maxResultBytes: 65_536, log: () => { throw new Error('Private failures must not be logged') },
      validate: async result => validateScopedCodingResult(result, authority) })
    assert.equal(published.code, 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD')
    assert.equal(JSON.stringify(published).includes('forbidden'), false)
    assert.equal(JSON.stringify(published).includes('private failure'), false)
  }
})

test('a delayed start acknowledges its admitted selection without extending any execution or publication lease', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-result-ack-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { acceptSessionPairingSource, prepareManagedBridgeCall, preparedManagedSessionAuthority } =
    await import('../src/coding-session/session-authority.js')
  const { callCodingBridgeTool } = await import('../src/coding-session/bridge-server.js')
  const keys = await import('../src/coding-session/meta-keys.js')
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const authority: ExecutorCodingSessionAuthority = { ...scope(), operation: 'session_start', purpose: 'control',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5_000).toISOString() }
  const source = { kind: 'bound' as const, executorId: authority.executorId,
    originalOwnerGeneration: authority.originalOwnerGeneration, machinePublicKeyDigest: 'c'.repeat(64),
    acceptedPairing: { kind: 'code' as const, id: randomUUID() } }
  await acceptSessionPairingSource(directory, source)
  const sessionId = randomUUID()
  const result = { sessionId, startPhase: 'request_and_host_created', startEvidence: managedSessionEvidence({
    executorId: authority.executorId, originalOwnerGeneration: authority.originalOwnerGeneration,
    startCommandId: authority.commandId }, sessionId, authority.ownerKey) }
  const request = { name: 'session_start', arguments: {}, _meta: {
    [keys.CODING_SESSION_COMMAND_META]: authority.commandId,
    [keys.CODING_SESSION_OWNER_META]: authority.ownerKey,
    [keys.CODING_SESSION_AUTHORITY_META]: authority,
    [keys.CODING_SESSION_PAIRING_SOURCE_META]: source,
    [keys.CODING_SESSION_CONNECTION_META]: authority.connectionEpoch,
  } }
  const identity = (text: string) => text
  const bridge = { rewriter: { rewrite: identity, rewritePaths: identity, rewriteBranch: identity },
    call: async (tool: string, args: unknown, meta: import('../src/coding-session/bridge.js').CodingBridgeCallMeta) => {
      await prepareManagedBridgeCall(directory, directory, tool, args, meta)
      now += 12_000
      assert.throws(() => preparedManagedSessionAuthority(meta), 'expired execution authority stays unusable')
      return result
    } }
  const raw = await callCodingBridgeTool(bridge, request)
  assert.notEqual('isError' in raw && raw.isError, true)
  const body = JSON.parse(raw.content[0]!.text)
  assert.deepEqual(body.resultScope, executorCodingSessionResultScope(authority))
  assert.equal(body.sessionId, sessionId)
  assert.equal('expiresAt' in body.resultScope, false, 'the acknowledgement is not a renewable lease')
  const publish = (grant: ExecutorCodingSessionAuthority) => publishExecutorMcpResult(raw, {
    server: 'coding-sessions', tool: 'session_start', maxResultBytes: 65_536, log: () => {},
    validate: async answer => validateScopedCodingResult(answer, grant),
  })
  assert.equal((await publish(authority)).code, 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD')
  const renewed = { ...authority, issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5_000).toISOString() }
  assert.deepEqual(validateScopedCodingResult(raw, renewed), raw)
  for (const patch of [{ originalOwnerGeneration: randomUUID() }, { ownerKey: 'sha256:' + 'b'.repeat(64) },
    { commandId: randomUUID() }, { connectionEpoch: '2' }, { authorizationRevision: 2 }]) {
    assert.equal((await publish({ ...renewed, ...patch })).code, 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD')
  }
  now = Date.parse(authority.issuedAt)
  const { CodingBridgeError } = await import('../src/coding-session/bridge-tools.js')
  const failed = await callCodingBridgeTool({ ...bridge, call: async (...args) => {
    await bridge.call(...args)
    throw new CodingBridgeError('coding_session_unavailable', 'private delayed failure')
  } }, request)
  assert.equal(failed.isError, true)
  const refusal = validateScopedCodingResult(failed, renewed)
  assert.equal(JSON.stringify(refusal).includes('private delayed failure'), false)
  assert.match(JSON.stringify(refusal), /coding_session_call_refused/)
  const unprepared = await callCodingBridgeTool({ ...bridge, call: async () => result }, request)
  assert.equal((await publishExecutorMcpResult(unprepared, { server: 'coding-sessions', tool: 'session_start',
    maxResultBytes: 65_536, log: () => {},
    validate: async answer => validateScopedCodingResult(answer, renewed) })).code,
  'EXECUTOR_CODING_SESSION_RESULT_WITHHELD', 'wire fields alone cannot produce an acknowledgement')
})
