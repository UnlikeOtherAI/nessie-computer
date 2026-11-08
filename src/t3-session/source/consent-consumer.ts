import { createHash } from 'node:crypto'
import { requireCapture } from '../state/sqlite.js'
import { parseRetainedImportChallenge, parseRetainedImportReceipt, parseRetainedImportVerification,
  parseRetainedImportLiveProof, retainedImportChallengeDigest } from './consent-contract.js'
import type { RetainedImportApprovalReceiptV1, RetainedImportChallengeV1,
  RetainedImportVerificationV1, RetainedImportLiveProofV1 } from './consent-contract.js'
import { verifyNativeRetainedConsent } from './consent-native.js'
import { machineT3Sources } from './owner.js'

export interface RetainedImportConsentLease {
  readonly challenge: RetainedImportChallengeV1
  readonly receipt: RetainedImportApprovalReceiptV1
  readonly initialProof: RetainedImportLiveProofV1
  recheck(): Promise<void>
  recheck(verification: RetainedImportVerificationV1): Promise<RetainedImportLiveProofV1>
  revoke(): Promise<void>
  revoke(verification: RetainedImportVerificationV1): Promise<RetainedImportLiveProofV1>
}

/** Called only by the registered owner. No injectable native verifier or local
 * affirmation callback exists, and a serialized receipt cannot mint a lease. */
export async function consumeRetainedConsent(executorId: string, input: {
  readonly challenge: unknown; readonly receipt: unknown; readonly physicalSourceRecheck: () => Promise<void>
  readonly verification: unknown
}): Promise<RetainedImportConsentLease> {
  const challenge = parseRetainedImportChallenge(input.challenge)
  const owner = machineT3Sources(executorId)
  const receipt = parseRetainedImportReceipt(input.receipt, challenge)
  const digest = retainedImportChallengeDigest(challenge)
  const verification = parseRetainedImportVerification(input.verification, challenge)
  const bind = async () => {
    parseRetainedImportChallenge(challenge)
    const live = await owner.recognize(input.physicalSourceRecheck)
    const s = challenge
    requireCapture(live.executorId === challenge.executorId && live.source.environmentId === s.environmentId
      && live.source.admittedRootKey === s.admittedRootKey && live.source.physicalRootKey === s.physicalRootKey
      && live.databaseIdentity === s.databaseIdentity && live.environmentIdentity === s.environmentIdentity,
    'retained_import_physical_source_mismatch')
  }
  await bind()
  const consumed = await verifyNativeRetainedConsent({ operation: 'consume', challenge, receipt, verification })
  requireCapture(consumed.challengeDigest === digest && typeof consumed.consumption === 'string'
    && /^[a-f0-9]{64}$/u.test(consumed.consumption), 'retained_import_native_invalid')
  const consumption = consumed.consumption
  const consumptionId = createHash('sha256').update(consumption).digest('hex')
  let revoked = false
  async function revoke(): Promise<void>
  async function revoke(v: RetainedImportVerificationV1): Promise<RetainedImportLiveProofV1>
  async function revoke(v?: RetainedImportVerificationV1): Promise<void | RetainedImportLiveProofV1> {
    revoked = true
    const verification = v && parseRetainedImportVerification(v, challenge)
    const reply = await verifyNativeRetainedConsent({ operation: 'revoke', challenge, receipt, consumption, verification })
    if (verification) return parseRetainedImportLiveProof(reply.proof, challenge, receipt, verification, 'revoke', consumptionId)
  }
  let initialProof: RetainedImportLiveProofV1
  try {
    initialProof = parseRetainedImportLiveProof(consumed.proof, challenge, receipt, verification, 'consume', consumptionId)
    await bind()
  } catch (error) { try { await revoke() } catch { /* Refusal stays sticky locally. */ } throw error }
  async function recheck(): Promise<void>
  async function recheck(v: RetainedImportVerificationV1): Promise<RetainedImportLiveProofV1>
  async function recheck(v?: RetainedImportVerificationV1): Promise<void | RetainedImportLiveProofV1> {
      requireCapture(!revoked, 'retained_import_consent_revoked')
      try {
        await bind()
        const verification = v && parseRetainedImportVerification(v, challenge)
        const reply = await verifyNativeRetainedConsent({ operation: 'recheck', challenge, receipt, consumption, verification })
        requireCapture(reply.challengeDigest === digest, 'retained_import_native_invalid')
        await bind()
        requireCapture(!revoked, 'retained_import_consent_revoked')
        if (verification) return parseRetainedImportLiveProof(reply.proof, challenge, receipt, verification, 'recheck', consumptionId)
      } catch (error) { try { await revoke() } catch { /* Local revocation remains sticky. */ } throw error }
  }
  return Object.freeze({ challenge, receipt, initialProof, recheck, revoke })
}
