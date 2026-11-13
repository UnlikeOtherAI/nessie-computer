import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import * as Effect from 'effect/Effect'
import { makeSessionLaunchCommandLineage } from '../../dist/t3-session/runtime/command-lineage.js'
import { T3_EXECUTION_ASSOCIATION_DOMAIN, executionReceiptBytes } from '@nessie/executor-protocol/t3-session'

// Real receipt signatures and original lineage; native process/HTTP methods in
// callers are transport doubles. This creates no enrolled authority or provider.
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
export const providerFrameFixture = async () => {
  const key = generateKeyPairSync('ed25519')
  const der = key.publicKey.export({ type: 'spki', format: 'der' })
  const keyId = createHash('sha256').update(der).digest('hex')
  const generation = { pid: 1, startedAt: 'fixture-start', bootId: 'fixture-boot' }
  const custody = { service: generation, controller: generation, supervisor: generation, runtime: generation,
    jobName: 'Global\\NessieCustody-' + 'a'.repeat(64), releaseDigest: 'b'.repeat(64), serviceImageDigest: 'c'.repeat(64) }
  const binding = { executorId: '11111111-1111-4111-8111-111111111111', environmentId: 'original-environment',
    threadId: 'original-thread', providerInstanceId: 'original-codex', connectionEpoch: '1', runtimeGeneration: 'writer',
    correlationId: 'original-correlation', commandId: 'launch-command', requestSha256: hash('request'),
    relayHmac: 'hmac-sha256:' + 'd'.repeat(64), actorReference: hash('actor'), initiationReference: hash('initiation'),
    sourceEvidenceDigest: hash('evidence'), sourceRootKey: 'source', sourceGeneration: 'capture', driver: 'codex',
    continuationHomeKey: 'continuation-home', historyHomeKey: 'history-home', credentialBindingId: 'credential' }
  const now = Date.now()
  const preparation = { version: 1, reservationId: 'e'.repeat(64), admissionDigest: hash('admission'), binding,
    custody, nonce: 'f'.repeat(64), issuedAtMs: now, expiresAtMs: now + 5000, processPurpose: 'provider',
    launchDigest: hash('launch'), providerSessionId: 'allocated-original-session' }
  const descriptor = { version: 1, executorId: binding.executorId, pairedOrigin: 'https://api.example.test',
    keyId, publicKey: der.toString('base64'), custody }
  const association = { ...preparation, nativeId: 'observed-native-id', provider: generation,
    providerImageDigest: '0'.repeat(64), observation: { kind: 'service-held-provider-stdout',
      frameDigest: hash('observed-frame'), requestId: 'original-protocol-id', observedAtMs: now } }
  const payload = JSON.stringify(association)
  const receipt = { domain: T3_EXECUTION_ASSOCIATION_DOMAIN, payload, keyId,
    signature: sign(null, executionReceiptBytes(T3_EXECUTION_ASSOCIATION_DOMAIN, payload), key.privateKey)
      .toString('base64url') }
  const parent = new AbortController()
  const lineage = makeSessionLaunchCommandLineage(binding, async () => {}, parent.signal)
  const initial = { parentCommandId: binding.commandId, commandId: 'initial-child', threadId: binding.threadId,
    messageId: 'original-message' }
  const run = { ...initial, runId: 'original-run' }
  const release = { parentCommandId: binding.commandId, commandId: 'release-child', threadId: binding.threadId,
    runId: run.runId }
  for (const [method, edge] of [['recordInitialMessage', initial], ['recordInitialMessageRun', run],
    ['recordPreparedRunRelease', release], ['recordPreparedRunReleased', release]]) {
    await Effect.runPromise(lineage.service[method](edge))
  }
  const originalEffect = { effectId: 'original-outbox-effect', commandId: release.commandId,
    threadId: binding.threadId, effectType: 'provider-turn.start', runId: run.runId }
  const proof = () => ({ keyId: 'fixture-backend', signature: 'a'.repeat(86), grant: {
    kind: 't3-effect', version: 1, purpose: 'execute', executorId: binding.executorId,
    environmentId: binding.environmentId, threadId: binding.threadId, providerSessionId: preparation.providerSessionId,
    connectionEpoch: binding.connectionEpoch, runtimeGeneration: binding.runtimeGeneration,
    correlationId: binding.correlationId, commandId: binding.commandId, requestDigest: binding.relayHmac,
    nativeAssociation: { driver: binding.driver, nativeId: association.nativeId,
      continuationHomeKey: binding.continuationHomeKey, historyHomeKey: binding.historyHomeKey },
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 4000).toISOString(),
    requestNonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestProofDigest: hash('request-proof'),
  } })
  return { preparation, descriptor, association, receipt, parent, lineage, originalEffect, proof }
}
