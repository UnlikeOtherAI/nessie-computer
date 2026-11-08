import { RetainedImportVerificationSchema, RetainedImportLiveProofSchema, canonicalExecutorJson,
  type RetainedImportLease } from '@nessie/executor-protocol'
import type { RetainedImportConsentLease } from '../source/consent-consumer.js'
import { requireCapture } from '../state/sqlite.js'
import { retainedImportPost } from './import-transport.js'

/** Verify the actual consent against the server nonce and immutable lease. This
 * does not read source rows or attest inherited history. The opaque native lease
 * performs its held-source check before and after every signed exchange.
 */
export async function recheckRetainedImportLease(stateDirectory: string, lease: RetainedImportLease,
  consent: RetainedImportConsentLease, threadId?: string): Promise<void> {
  requireCapture(lease.grantId === consent.challenge.challengeId
    && lease.generation === consent.challenge.grantGeneration
    && lease.sourceOwnerGeneration === consent.receipt.issuerInstance
    && lease.localApprovalId === consent.receipt.receiptId
    && Date.now() < Date.parse(lease.expiresAt), 'retained_import_consent_substitution')
  const verification = RetainedImportVerificationSchema.parse(await retainedImportPost(stateDirectory, {
    operation: 'verification.issue', grantId: lease.grantId, purpose: 'recheck', leaseId: lease.leaseId,
    ...(lease.operationBinding ? { operationBinding: lease.operationBinding } : {}),
  }))
  const liveProof = RetainedImportLiveProofSchema.parse(await consent.recheck(verification))
  const answer = await retainedImportPost(stateDirectory, {
    operation: 'lease.check', leaseId: lease.leaseId, token: lease.token, grantId: lease.grantId, liveProof,
    generation: lease.generation, sourceOwnerGeneration: lease.sourceOwnerGeneration,
    selectionKey: lease.selectionKey,
    ...(lease.operationBinding ? { operationBinding: lease.operationBinding } : {}),
    source: { executorId: lease.executorId, environmentId: lease.environmentId,
      physicalRootKey: lease.physicalRootKey, admittedRootKey: lease.admittedRootKey,
      databaseIdentity: lease.databaseIdentity, environmentIdentity: lease.environmentIdentity,
      captureGeneration: lease.captureGeneration }, purpose: lease.purpose, ...(threadId ? { threadId } : {}),
  }) as { basis?: string; selection?: unknown; selectionKey?: string; generation?: string;
    expiresAt?: string; operationBinding?: unknown }
  requireCapture(answer.basis === 'prospective_import' && answer.generation === lease.generation
    && answer.expiresAt === lease.expiresAt && answer.selectionKey === lease.selectionKey
    && canonicalExecutorJson(answer.operationBinding ?? null) === canonicalExecutorJson(lease.operationBinding ?? null)
    && canonicalExecutorJson(answer.selection) === canonicalExecutorJson(lease.selection),
  'retained_import_server_scope_changed')
  await consent.recheck()
  requireCapture(Date.now() < Date.parse(lease.expiresAt), 'retained_import_lease_expired')
}
