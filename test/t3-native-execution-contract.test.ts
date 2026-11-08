import assert from 'node:assert/strict'
import test from 'node:test'
import { executionAdmissionBytes, executionReceiptBytes, T3_EXECUTION_ADMISSION_DOMAIN,
  T3ExecutionCustodySchema, T3ExecutionAdmissionSchema } from '../packages/protocol/src/t3-session/native-execution.js'

test('execution signatures separate domain and exact payload with one U+000A', () => {
  const payload = '{"value":"雪"}'
  const bytes = executionAdmissionBytes(payload)
  assert.equal(bytes[T3_EXECUTION_ADMISSION_DOMAIN.length], 10)
  assert.deepEqual(bytes, executionReceiptBytes(T3_EXECUTION_ADMISSION_DOMAIN, payload))
  assert.equal(Buffer.from(bytes).toString(), T3_EXECUTION_ADMISSION_DOMAIN + String.fromCharCode(10) + payload)
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
