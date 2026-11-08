import assert from 'node:assert/strict'
import test from 'node:test'
import { RETAINED_IMPORT_TOOL_OPERATIONS, projectRetainedImportToolResult,
  retainedIssuerReviewPath, retainedImportGrantPath } from '@nessie/executor-protocol'

const id = '11111111-1111-4111-8111-111111111111'
const source = { executorId: id, environmentId: 'environment:原本', admittedRootKey: 'alias:český',
  physicalRootKey: 'root:原本', databaseIdentity: 'db:original', environmentIdentity: 'env:identity' }
const recipient = { subject: 'private-subject', organizationId: 'private-org', teamId: 'private-team' }
const issuerChallenge = { ...source, enrollmentId: id, keyId: 'a'.repeat(64), publicKey: 'private-key-canary',
  nonce: 'n'.repeat(43), recipient, expiresAtMs: 12345 }
const issuer = { enrollmentId: id, status: 'pending-human', challenge: issuerChallenge,
  delegation: 'prospective-source-issuer', historicalOwnership: 'unproven' }
const request = { requestId: id, issuerEnrollmentId: id,
  selection: { kind: 'threads', projectIds: ['project:z', 'project:a'], threadIds: ['mcp:český', 'thread:a'] },
  acceptedBaseline: 'not_attested_by_original_source', grantExpiresAtMs: 12345 }
const challenge = { ...source, ...request, version: 1, challengeId: id, nonce: 'n'.repeat(43),
  captureGeneration: 'capture:1', grantGeneration: id, organizationId: id, teamId: id, recipient,
  purpose: 'retained-import-read-publish', issuedAtMs: 1, expiresAtMs: 12345, issuerKeyId: 'a'.repeat(64) }

test('retained tool inventory is finite and excludes every human and native authority operation', () => {
  assert.deepEqual(RETAINED_IMPORT_TOOL_OPERATIONS.map(o => o.method), [
    'discover', 'requestIssuer', 'readIssuer', 'revokeIssuer', 'requestImport', 'listGrants', 'readGrant', 'revokeGrant',
  ])
  assert.ok(RETAINED_IMPORT_TOOL_OPERATIONS.every(o => o.kind === 'finite'))
  const operation = RETAINED_IMPORT_TOOL_OPERATIONS.find(o => o.method === 'requestImport')!
  assert.deepEqual(operation.inputSchema.parse(request), request)
  for (const extra of [{ actor: recipient }, { ssoVerification: 'canary' }, { consent: true }, { token: 'canary' }]) {
    assert.equal(operation.inputSchema.safeParse({ ...request, ...extra }).success, false)
  }
})

test('all issuer projections preserve review metadata and remove approval material', () => {
  for (const method of ['requestIssuer', 'readIssuer', 'revokeIssuer'] as const) {
    const output = projectRetainedImportToolResult(method, issuer)
    const encoded = JSON.stringify(output)
    for (const forbidden of ['nonce', 'publicKey', 'recipient', 'private-subject', 'private-key-canary']) {
      assert.ok(!encoded.includes(forbidden), forbidden)
    }
    assert.ok(encoded.includes('unproven'))
    assert.ok(encoded.includes(retainedIssuerReviewPath(id, id)))
  }
})

test('discovery preserves exact offer order without exposing key possession material', () => {
  const other = '22222222-2222-4222-8222-222222222222'
  const offer = { ...source, keyId: issuerChallenge.keyId, publicKey: issuerChallenge.publicKey, expiresAtMs: 12345 }
  const output = projectRetainedImportToolResult('discover', {
    offers: [{ ...offer, offerId: other }, { ...offer, offerId: id }], enrollments: [issuer],
  })
  assert.ok('offers' in output)
  assert.deepEqual(output.offers.map(o => o.offerId), [other, id])
  assert.deepEqual(output.offers[0].source, source)
  assert.ok(!JSON.stringify(output).includes(issuerChallenge.publicKey))
  assert.throws(() => projectRetainedImportToolResult('discover', {
    offers: Array.from({ length: 101 }, () => ({ ...offer, offerId: id })), enrollments: [],
  }))
})

test('import recovery retains request ID, original selection order and unattested provenance', () => {
  const output = projectRetainedImportToolResult('requestImport', challenge)
  assert.ok(output && 'requestId' in output && 'selection' in output)
  assert.equal(output.requestId, id)
  assert.deepEqual(output.selection, request.selection)
  assert.ok(JSON.stringify(output).includes('not_attested_by_original_source'))
  assert.ok(JSON.stringify(output).includes(retainedImportGrantPath(id, id)))
  for (const field of ['nonce', 'recipient', 'private-subject', 'token']) assert.ok(!JSON.stringify(output).includes(field))
  const grant = { grantId: id, generation: id, status: 'revoked', basis: 'prospective_import',
    legacyCopyProvenance: request.acceptedBaseline, selection: request.selection, challenge, expiresAtMs: 12345 }
  const list = projectRetainedImportToolResult('listGrants', [grant])
  assert.ok(Array.isArray(list))
  assert.deepEqual(projectRetainedImportToolResult('readGrant', grant), list[0])
  assert.throws(() => projectRetainedImportToolResult('readGrant', { ...grant, grantId: '22222222-2222-4222-8222-222222222222' }))
  assert.deepEqual(projectRetainedImportToolResult('revokeGrant', { grantId: id, status: 'revoked' }),
    { grantId: id, status: 'revoked' })
})
