import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ExecutorCodingSessionAuthoritySchema, type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { managedSessionEvidence, requireManagedSessionEvidence } from '../src/coding-session/session-authority.js'

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
