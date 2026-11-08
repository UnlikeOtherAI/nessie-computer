import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { executionAdmissionBytes, executionReceiptBytes, T3_EXECUTION_ADMISSION_DOMAIN,
  T3_EXECUTION_INSPECTION_DOMAIN, T3_EXECUTION_GRAPH_DOMAIN, T3ExecutionInspectionSchema,
  T3ExecutionCustodySchema, T3ExecutionAdmissionSchema,
  T3ExecutionPreparationPayloadSchema } from '../packages/protocol/src/t3-session/native-execution.js'
import { verifyT3ExecutionReceiptSignature } from '../src/t3-execution-native-client.js'
import { T3ExecutionSecretPlanSelectionSchema, T3ExecutionSecretDeliveryHeaderSchema,
  T3ExecutionSecretObservationUnavailableSchema,
  executionSecretReadAdmissionBytes, T3_EXECUTION_SECRET_READ_DOMAIN,
} from '../packages/protocol/src/t3-session/execution-secret-read.js'
import { protectedT3SecretInstalledFrame, type VerifiedT3SecretDelivery } from '../src/t3-protected-process.js'

test('secret observation cannot promote its negative result to a receipt or value', () => {
  const unavailable = { status: 'unavailable', reason: 'T3_SECRET_READ_NONINTERACTIVE_UNQUALIFIED',
    attemptId: 'a'.repeat(64) }
  assert.ok(T3ExecutionSecretObservationUnavailableSchema.safeParse(unavailable).success)
  for (const patch of [{ status: 'ready' }, { value: 'secret' }, { payload: '{}' },
    { signature: 'caller' }, { retryAfterMs: 1 }]) {
    assert.equal(T3ExecutionSecretObservationUnavailableSchema.safeParse({ ...unavailable, ...patch }).success, false)
  }
})

test('secret plans preserve original indices and forbid synthetic config slots', () => {
  const reference = { provider: 'vault', reference: 'op://vault/item/field' }
  const environment = [{ index: 1, name: 'FIRST', reference }, { index: 3, name: 'SECOND', reference }]
  const selection = { environment, config: [], references: [reference, reference] }
  assert.ok(T3ExecutionSecretPlanSelectionSchema.safeParse(selection).success)
  for (const patch of [{ environment: [...environment].reverse() }, { references: [reference] },
    { config: [{ field: 'invented', reference }] }, { environment: [environment[0], environment[0]] }]) {
    assert.equal(T3ExecutionSecretPlanSelectionSchema.safeParse({ ...selection, ...patch }).success, false)
  }
})

test('secret transport metadata cannot carry values or mint an installation ACK', () => {
  const hex = 'a'.repeat(64), generation = { pid: 42, startedAt: '1', bootId: 'boot' }
  const header = { version: 1, type: 't3.secret.value', graphId: hex, readId: hex, slotId: hex, nonce: hex,
    admissionDigest: `sha256:${hex}`, recipient: generation, child: generation, expiresAtMs: 5000,
    byteLength: 5, clearance: 'service-observed-job-empty' }
  assert.ok(T3ExecutionSecretDeliveryHeaderSchema.safeParse(header).success)
  for (const patch of [{ value: 'secret' }, { valueDigest: `sha256:${hex}` }, { byteLength: 65537 }]) {
    assert.equal(T3ExecutionSecretDeliveryHeaderSchema.safeParse({ ...header, ...patch }).success, false)
  }
  assert.throws(() => protectedT3SecretInstalledFrame({} as VerifiedT3SecretDelivery))
  const payload = '{"exact":"雪"}'
  assert.equal(Buffer.from(executionSecretReadAdmissionBytes(payload)).toString(),
    T3_EXECUTION_SECRET_READ_DOMAIN + String.fromCharCode(10) + payload)
})

test('execution signatures separate domain and exact payload with one U+000A', () => {
  const payload = '{"value":"雪"}'
  const bytes = executionAdmissionBytes(payload)
  assert.equal(bytes[T3_EXECUTION_ADMISSION_DOMAIN.length], 10)
  assert.deepEqual(bytes, executionReceiptBytes(T3_EXECUTION_ADMISSION_DOMAIN, payload))
  assert.equal(Buffer.from(bytes).toString(), T3_EXECUTION_ADMISSION_DOMAIN + String.fromCharCode(10) + payload)
})

test('inspection accepts an exact empty target ledger without prospective provider IDs', () => {
  const sha = `sha256:${'a'.repeat(64)}`
  const inspection = { version: 1, inspectionId: 'a'.repeat(64), issuerKeyId: 'b'.repeat(64),
    nonce: 'c'.repeat(64), executorId: 'executor', environmentId: 'environment', connectionEpoch: 'epoch',
    runtimeGeneration: 'runtime', correlationId: 'correlation', commandId: 'command', requestSha256: sha,
    relayHmac: `hmac-sha256:${'d'.repeat(64)}`, actorReference: sha, initiationReference: sha,
    sourceRootKey: 'root', sourceGeneration: 'source', sourceRevision: '25bf84ab07f53f141c20239c63e383823a9d5ea0',
    targets: [], issuedAtMs: 1000, expiresAtMs: 6000 }
  assert.ok(T3ExecutionInspectionSchema.safeParse(inspection).success)
  for (const extra of [{ nativeId: 'guessed' }, { providerSessionId: 'guessed' }, { providerInstanceId: 'guessed' },
    { expiresAtMs: 6001 }, { sourceRevision: 'a'.repeat(64) }, { relayHmac: sha }]) {
    assert.equal(T3ExecutionInspectionSchema.safeParse({ ...inspection, ...extra }).success, false)
  }
  assert.notDeepEqual(executionReceiptBytes(T3_EXECUTION_INSPECTION_DOMAIN, JSON.stringify(inspection)),
    executionAdmissionBytes(JSON.stringify(inspection)))
  assert.equal(T3ExecutionPreparationPayloadSchema.shape.providerSessionId.safeParse(undefined).success, false)
  assert.equal(T3ExecutionPreparationPayloadSchema.shape.processPurpose.safeParse(undefined).success, false)
  assert.equal(T3ExecutionPreparationPayloadSchema.shape.processPurpose.safeParse('claude-history-fork').success, true)
})

test('native receipt signatures reject byte changes, another key and another domain', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const keyId = createHash('sha256').update(der).digest('hex')
  const generation = { pid: 42, startedAt: '1', bootId: 'boot' }
  const descriptor = { version: 1 as const, executorId: 'executor', pairedOrigin: 'https://api.example.test',
    keyId, publicKey: der.toString('base64'), custody: { service: generation, controller: generation,
      supervisor: generation, runtime: generation, jobName: `Global\\NessieCustody-${'a'.repeat(64)}`,
      releaseDigest: 'b'.repeat(64), serviceImageDigest: 'c'.repeat(64) } }
  const payload = '{"exact":"雪"}'
  const receipt = { domain: T3_EXECUTION_GRAPH_DOMAIN, payload, keyId,
    signature: sign(null, executionReceiptBytes(T3_EXECUTION_GRAPH_DOMAIN, payload), privateKey).toString('base64url') }
  assert.deepEqual(verifyT3ExecutionReceiptSignature(receipt, descriptor), receipt)
  for (const extra of [{ payload: payload + ' ' }, { domain: 'nessie.t3.execution.association.v1' },
    { keyId: 'd'.repeat(64) }, { signature: receipt.signature + '=' }]) {
    assert.throws(() => verifyT3ExecutionReceiptSignature({ ...receipt, ...extra }, descriptor))
  }
  assert.throws(() => verifyT3ExecutionReceiptSignature(receipt, { ...descriptor, keyId: 'e'.repeat(64) }))
})

test('custody Job namespace has one actual Windows separator', () => {
  const generation = { pid: 42, startedAt: '1', bootId: 'boot' }
  const custody = { service: generation, controller: generation, supervisor: generation, runtime: generation,
    jobName: 'Global' + String.fromCharCode(92) + 'NessieCustody-' + 'a'.repeat(64),
    releaseDigest: 'b'.repeat(64), serviceImageDigest: 'c'.repeat(64) }
  assert.ok(T3ExecutionCustodySchema.safeParse(custody).success)
  assert.equal(T3ExecutionCustodySchema.safeParse({ ...custody,
    jobName: custody.jobName.replace(String.fromCharCode(92), String.fromCharCode(92, 92)) }).success, false)
})

test('reservation has no native/provider session fields and expires within five seconds', () => {
  const sha = `sha256:${'a'.repeat(64)}`
  const binding = { executorId: 'e', environmentId: 'env', threadId: 'thread', providerInstanceId: 'instance',
    connectionEpoch: '1', runtimeGeneration: 'runtime', correlationId: 'correlation', commandId: 'command',
    requestSha256: sha, relayHmac: `hmac-sha256:${'b'.repeat(64)}`, actorReference: sha, initiationReference: sha,
    sourceEvidenceDigest: sha, sourceRootKey: 'root', sourceGeneration: 'source', driver: 'codex',
    continuationHomeKey: 'continue', historyHomeKey: 'history', credentialBindingId: 'credential' }
  const reserve = { version: 1, phase: 'reserve', binding, reservationId: 'a'.repeat(64), issuerKeyId: 'b'.repeat(64),
    releaseDigest: 'c'.repeat(64), nonce: 'd'.repeat(64), issuedAtMs: 1000, expiresAtMs: 6000 }
  assert.ok(T3ExecutionAdmissionSchema.safeParse(reserve).success)
  for (const patch of [{ expiresAtMs: 1000 }, { expiresAtMs: 6001 }, { nativeId: 'placeholder' },
    { providerSessionId: 'placeholder' }, { binding: { ...binding, providerSessionId: 'placeholder' } }]) {
    assert.equal(T3ExecutionAdmissionSchema.safeParse({ ...reserve, ...patch }).success, false)
  }
})
