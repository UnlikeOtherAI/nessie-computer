import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { RetainedImportLeaseSchema } from '@nessie/executor-protocol'
import { decodeExecutorT3Request, encodeExecutorT3Request, T3_SOURCE_COMMIT } from '@nessie/executor-protocol/t3-session'
import { retainedImportOperationBinding } from '../src/t3-session/ownership/import-operation.js'

function fixture() {
  const request = decodeExecutorT3Request({ transportVersion: 1, protocolVersion: 2,
    sourceRevision: T3_SOURCE_COMMIT, executorId: randomUUID(), environmentId: 'original:environment',
    connectionEpoch: '1', runtimeGeneration: 'held:runtime', correlationId: 'read:one', relayOrdinal: 0,
    kind: 'request', method: 'orchestration.subscribeThread', input: { threadId: 'original:thread' } })
  const relayRequestDigest = `hmac-sha256:${'a'.repeat(64)}`
  const binding = { requestDigest: createHash('sha256').update(JSON.stringify(encodeExecutorT3Request(request))).digest('hex'),
    relayRequestDigest, correlationId: request.correlationId, scope: { kind: 'thread', threadId: 'original:thread' } }
  const lease = RetainedImportLeaseSchema.parse({ executorId: request.executorId, environmentId: request.environmentId,
    physicalRootKey: 'root:physical', admittedRootKey: 'root:admitted', databaseIdentity: 'database:one',
    environmentIdentity: 'environment:one', captureGeneration: 'capture:one', leaseId: randomUUID(),
    token: 'b'.repeat(43), grantId: randomUUID(), generation: randomUUID(), sourceOwnerGeneration: 'c'.repeat(64),
    localApprovalId: 'd'.repeat(64), selection: { kind: 'whole_source' }, purpose: 'catalog',
    expiresAt: new Date(Date.now() + 30_000).toISOString(), basis: 'prospective_import',
    legacyCopyProvenance: 'not_attested_by_original_source', selectionKey: 'e'.repeat(64), operationBinding: binding })
  return { request, lease, relayRequestDigest }
}

test('original operation and keyed offer correlation are both required', () => {
  const f = fixture()
  assert.deepEqual(retainedImportOperationBinding(f.lease, f.request, f.relayRequestDigest), f.lease.operationBinding)
  for (const patch of [{ connectionEpoch: '2' }, { correlationId: 'read:other' },
    { runtimeGeneration: 'held:replacement' }, { input: { threadId: 'original:other' } }]) {
    const changed = decodeExecutorT3Request({ ...encodeExecutorT3Request(f.request), ...patch })
    assert.throws(() => retainedImportOperationBinding(f.lease, changed, f.relayRequestDigest),
      /retained_import_operation_substitution/)
  }
  assert.throws(() => retainedImportOperationBinding(f.lease, f.request, `hmac-sha256:${'f'.repeat(64)}`),
    /retained_import_operation_substitution/)
})

test('bootstrap or unbound catalog descriptor cannot serve an operation', () => {
  const f = fixture()
  const { operationBinding: _binding, ...bootstrap } = f.lease
  for (const purpose of ['capture', 'publish', 'catalog'] as const) {
    assert.throws(() => retainedImportOperationBinding({ ...bootstrap, purpose }, f.request, f.relayRequestDigest),
      /retained_import_operation_substitution/)
  }
})
