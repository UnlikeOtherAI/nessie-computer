import { performance } from 'node:perf_hooks'
import { RetainedImportLeaseSchema, RetainedImportChallengeSchema, RetainedImportLocalReceiptSchema,
  RetainedImportVerificationSchema, RetainedImportLiveProofSchema,
  RetainedImportActivationSchema, RetainedImportOperationBindingSchema, canonicalExecutorJson,
  type RetainedImportLease, type RetainedImportOperationBinding, type RetainedImportChallenge } from '@nessie/executor-protocol'
import { SourceContracts } from '@nessie/t3-session-source/engine'
import { machineT3Sources } from '../source/owner.js'
import type { RetainedImportConsentLease } from '../source/consent-consumer.js'
import type { ProvenT3Source } from '../import/manifest.js'
import type { RetainedReadScope } from './continuity.js'
import type { RetainedCatalogAuthorityPort, RetainedCatalogPublicationAuthorityPort,
  RetainedCatalogSelection } from '../catalog/selection.js'
import { requireCapture } from '../state/sqlite.js'
import type { CaptureDatabase } from '../state/sqlite.js'
import { retainedImportPost } from './import-transport.js'
import { recheckRetainedImportLease } from './import-local-check.js'

export interface RetainedImportReadScope extends RetainedReadScope {
  readonly basis: 'prospective-import-grant'
  readonly grantId: string
  readonly selectionKey: string
  readonly legacyCopyProvenance: 'not_attested_by_original_source'
  recheckSelection(): Promise<void>
}
export interface RetainedImportAuthorityPort {
  readonly basis: 'prospective-import-grant'
  readonly captureGeneration: string
  withReadScope<A>(input: { source: ProvenT3Source; physicalSourceRecheck: () => Promise<void>;
    captureGeneration: string; purpose: 'retained-import-read' },
  use: (scope: RetainedImportReadScope) => Promise<A>): Promise<A>
}

export interface RetainedImportLocalContext {
  /** Exact consumption bootstrap; never used as a lane caller's catalog lease. */
  readonly bootstrapLeases: readonly RetainedImportLease[]
  readonly grant: { grantId: string; generation: string; status: 'active'; basis: 'prospective_import';
    legacyCopyProvenance: 'not_attested_by_original_source' }
  readonly challenge: RetainedImportChallenge
  readonly source: ProvenT3Source
  readonly database: CaptureDatabase
  readonly physicalSourceRecheck: () => Promise<void>
  readonly captureGeneration: string
  /** Local liveness only; server read admission is checked by authority scopes. */
  recheckLocalConsent(): Promise<void>
  bootstrapAuthority(purpose: 'capture' | 'publish'): RetainedImportAuthorityPort & RetainedCatalogPublicationAuthorityPort
  authority(lease: RetainedImportLease, operation?: RetainedImportOperationBinding):
    RetainedImportAuthorityPort & RetainedCatalogAuthorityPort
    & RetainedCatalogPublicationAuthorityPort
}

/** Real local+server composition. The serialized descriptor grants nothing until
 * both the protected native approval and the current backend lease are rechecked.
 */
function createRetainedImportAuthority(stateDirectory: string, raw: RetainedImportLease,
  consent: RetainedImportConsentLease, expectedOperation?: RetainedImportOperationBinding):
  RetainedImportAuthorityPort & RetainedCatalogAuthorityPort & RetainedCatalogPublicationAuthorityPort {
  const lease = RetainedImportLeaseSchema.parse(raw)
  const operation = expectedOperation && RetainedImportOperationBindingSchema.parse(expectedOperation)
  requireCapture(canonicalExecutorJson(lease.operationBinding ?? null) === canonicalExecutorJson(operation ?? null)
    && (!operation || lease.purpose === 'catalog'), 'retained_import_operation_substitution')
  requireCapture(lease.grantId === consent.challenge.challengeId
    && lease.generation === consent.challenge.grantGeneration
    && lease.sourceOwnerGeneration === consent.receipt.issuerInstance
    && lease.localApprovalId === consent.receipt.receiptId, 'retained_import_consent_substitution')
  // Freeze a parsed copy so a caller cannot widen selection while awaiting I/O.
  if (lease.selection.kind === 'threads') {
    Object.freeze(lease.selection.threadIds)
    Object.freeze(lease.selection.projectIds)
  }
  Object.freeze(lease.selection)
  if (lease.operationBinding) {
    Object.freeze(lease.operationBinding.scope)
    Object.freeze(lease.operationBinding)
  }
  Object.freeze(lease)

  const withScope = async <A>(input: { source: ProvenT3Source; physicalSourceRecheck: () => Promise<void>;
    captureGeneration: string }, use: (scope: RetainedImportReadScope) => Promise<A>): Promise<A> => {
    const owner = machineT3Sources(lease.executorId)
    const live = await owner.recognize(input.physicalSourceRecheck)
    requireCapture(live.source === input.source && live.executorId === lease.executorId
      && input.source.environmentId === lease.environmentId && input.source.physicalRootKey === lease.physicalRootKey
      && input.source.admittedRootKey === lease.admittedRootKey && input.captureGeneration === lease.captureGeneration
      && live.databaseIdentity === lease.databaseIdentity && live.environmentIdentity === lease.environmentIdentity,
    'retained_import_source_substitution')
    const startedAt = Date.now()
    const monotonic = performance.now()
    const remaining = Math.min(60_000, Date.parse(lease.expiresAt) - startedAt)
    requireCapture(remaining > 0, 'retained_import_lease_expired')
    let active = true
    const requireLive = () => requireCapture(active && Date.now() >= startedAt
      && Date.now() < Date.parse(lease.expiresAt) && performance.now() - monotonic < remaining,
    'retained_import_lease_expired_or_closed')
    const recheck = async (threadId?: SourceContracts.ThreadId) => {
      try {
        requireLive()
        requireCapture(!threadId || lease.operationBinding?.scope.kind !== 'thread'
          || threadId === lease.operationBinding.scope.threadId, 'retained_import_operation_thread_substitution')
        const current = await owner.recognize(input.physicalSourceRecheck)
        requireCapture(current.source === input.source && current.executorId === lease.executorId,
          'retained_import_source_replaced')
        await recheckRetainedImportLease(stateDirectory, lease, consent, threadId)
        requireLive()
        requireCapture((await owner.recognize(input.physicalSourceRecheck)).source === input.source,
          'retained_import_source_replaced')
        requireLive()
      } catch (error) { active = false; throw error }
    }
    const scope: RetainedImportReadScope = Object.freeze({ basis: 'prospective-import-grant', grantId: lease.grantId,
      selectionKey: lease.selectionKey, legacyCopyProvenance: 'not_attested_by_original_source',
      recheckSource: () => recheck(), recheckThread: recheck, recheckSelection: () => recheck() })
    try {
      await recheck()
      const result = await use(scope)
      await recheck()
      return result
    } finally { active = false }
  }

  const selection = (): RetainedCatalogSelection => lease.operationBinding?.scope.kind === 'thread'
    ? Object.freeze({ basis: 'prospective-import-grant', revision: lease.selectionKey, scope: 'threads',
        threadIds: Object.freeze([SourceContracts.ThreadId.make(lease.operationBinding.scope.threadId)]),
        projectIds: Object.freeze([]) })
    : lease.selection.kind === 'whole_source'
    ? Object.freeze({ basis: 'prospective-import-grant', revision: lease.selectionKey, scope: 'environment-owner' })
    : Object.freeze({ basis: 'prospective-import-grant', revision: lease.selectionKey, scope: 'threads',
        threadIds: Object.freeze(lease.selection.threadIds.map(id => SourceContracts.ThreadId.make(id))),
        projectIds: Object.freeze(lease.selection.projectIds.map(id => SourceContracts.ProjectId.make(id))) })
  const authority: RetainedImportAuthorityPort & RetainedCatalogAuthorityPort & RetainedCatalogPublicationAuthorityPort = {
    basis: 'prospective-import-grant', captureGeneration: lease.captureGeneration,
    withReadScope: async (input, use) => {
      requireCapture(input.purpose === 'retained-import-read' && (lease.purpose === 'capture' || lease.purpose === 'read'),
        'retained_import_wrong_purpose')
      // The original whole-root capture cannot claim completeness for a subset.
      requireCapture(lease.purpose !== 'capture' || lease.selection.kind === 'whole_source',
        'retained_import_capture_requires_whole_source')
      requireCapture(lease.purpose !== 'read' || lease.selection.kind === 'whole_source',
        'retained_import_inherited_closure_unproven')
      return withScope(input, use)
    },
    withCatalogPublicationScope: async (input, use) => {
      requireCapture(input.purpose === 'retained-catalog-publish' && lease.purpose === 'publish',
        'retained_import_wrong_purpose')
      return withScope(input, scope => use({ ...scope, publicationGrantId: lease.grantId,
        selectionKey: lease.selectionKey, selection: selection() }))
    },
    withCatalogReadScope: async (input, use) => {
      requireCapture(input.purpose === 'retained-catalog-read' && lease.purpose === 'catalog',
        'retained_import_wrong_purpose')
      return withScope(input, scope => use({ ...scope, selection: selection() }))
    },
  }
  return Object.freeze(authority)
}

/** Tray receipt submission and all dependent local work share one actual native
 * consumption. The callback cannot outlive the held source or native issuer.
 * Remote activation requires the separately enrolled issuer signature and the
 * one-use native live proof. A failure withdraws the local reservation.
 */
export async function withRetainedImportLocally<A>(stateDirectory: string,
  input: { challenge: unknown; receipt: unknown },
  use: (result: RetainedImportLocalContext) => Promise<A>): Promise<A> {
  const challenge = RetainedImportChallengeSchema.parse(input.challenge)
  const receipt = RetainedImportLocalReceiptSchema.parse(input.receipt)
  const owner = machineT3Sources(challenge.executorId)
  return owner.withReadonlySource(await owner.manifest(), challenge.admittedRootKey,
    async (source, database, physicalSourceRecheck) => {
      const verification = RetainedImportVerificationSchema.parse(await retainedImportPost(stateDirectory, {
        operation: 'verification.issue', grantId: challenge.challengeId, purpose: 'consume',
      }))
      const consent = await owner.consumeRetainedImportApproval({ challenge, receipt, physicalSourceRecheck, verification })
      let committed = false
      try {
        await consent.recheck()
        const { bootstrapLeases, ...grant } = RetainedImportActivationSchema.parse(await retainedImportPost(stateDirectory, {
          operation: 'consent.commit', challenge, receipt,
          liveProof: RetainedImportLiveProofSchema.parse(consent.initialProof) }))
        requireCapture(grant.status === 'active' && grant.grantId === challenge.challengeId
          && grant.generation === challenge.grantGeneration, 'retained_import_commit_substitution')
        committed = true
        for (const lease of bootstrapLeases) await recheckRetainedImportLease(stateDirectory, lease, consent)
        await consent.recheck()
        const result = await use({ grant: { ...grant, status: 'active' }, source, database, physicalSourceRecheck,
          challenge, captureGeneration: challenge.captureGeneration, bootstrapLeases: Object.freeze(bootstrapLeases),
          recheckLocalConsent: () => consent.recheck(),
          bootstrapAuthority: purpose => {
            const lease = bootstrapLeases.find(item => item.purpose === purpose)
            requireCapture(lease && !lease.operationBinding, 'retained_import_bootstrap_unavailable')
            return createRetainedImportAuthority(stateDirectory, lease, consent)
          },
          authority: (lease, operation) => createRetainedImportAuthority(stateDirectory, lease, consent, operation) })
        await consent.recheck()
        return result
      } finally {
        let locallyRevoked = false
        try {
          if (committed) {
            const withdrawal = RetainedImportVerificationSchema.parse(await retainedImportPost(stateDirectory, {
              operation: 'verification.issue', grantId: challenge.challengeId, purpose: 'revoke',
            }))
            const liveProof = RetainedImportLiveProofSchema.parse(await consent.revoke(withdrawal))
            locallyRevoked = true
            await retainedImportPost(stateDirectory, { operation: 'consent.withdraw',
              grantId: challenge.challengeId, liveProof })
          }
        } finally { if (!locallyRevoked) await consent.revoke() }
      }
    })
}
