import { z } from 'zod'
import { RetainedIssuerEnrollmentInputSchema, RetainedIssuerReviewSchema,
  RetainedIssuerDiscoverySchema, RetainedIssuerSourceSchema } from './retained-import-issuer.js'
import { RetainedImportChallengeInputSchema, RetainedImportChallengeSchema,
  RetainedImportGrantReviewSchema, RetainedImportSourceSchema } from './retained-import.js'
import { retainedImportGrantPath, retainedIssuerReviewPath } from './retained-import-navigation.js'

const computer = z.object({ executorId: z.string().uuid() }).strict()
const enrollment = z.object({ enrollmentId: z.string().uuid() }).strict()
const grant = z.object({ grantId: z.string().uuid() }).strict()

/** Exact finite services only. Approval, verification, native proof and leases are deliberately absent. */
export const RETAINED_IMPORT_TOOL_OPERATIONS = ([
  { name: 'retained_import_issuers_list', method: 'discover', service: 'discoverRetainedImportIssuers',
    title: 'List retained source issuers', scope: 'coding_sessions_read', effect: 'read', retry: 'read_again',
    description: 'Discover current issuer offers and your enrollment reviews on one accessible computer.',
    inputSchema: computer },
  { name: 'retained_issuer_enrollment_request', method: 'requestIssuer', service: 'createRetainedIssuerEnrollment',
    title: 'Request retained issuer enrollment', scope: 'coding_sessions_execute', effect: 'write', retry: 'same_request_id',
    description: 'Request human review of one offered source issuer. Keep requestId on retry. This does not approve it.',
    inputSchema: RetainedIssuerEnrollmentInputSchema },
  { name: 'retained_issuer_enrollment_get', method: 'readIssuer', service: 'readRetainedIssuerEnrollment',
    title: 'Read retained issuer enrollment', scope: 'coding_sessions_read', effect: 'read', retry: 'read_again',
    description: 'Read your exact enrollment status and review metadata. Human and local confirmation remain separate.',
    inputSchema: enrollment },
  { name: 'retained_issuer_enrollment_revoke', method: 'revokeIssuer', service: 'revokeRetainedIssuerEnrollment',
    title: 'Revoke retained issuer enrollment', scope: 'coding_sessions_execute', effect: 'delete', retry: 'same_target_id',
    description: 'Permanently revoke your exact issuer enrollment. Repeating the same target reconciles withdrawal.',
    inputSchema: enrollment },
  { name: 'retained_import_request', method: 'requestImport', service: 'createRetainedImportChallenge',
    title: 'Request retained source import', scope: 'coding_sessions_execute', effect: 'write', retry: 'same_request_id',
    description: 'Request native source-owner review for an exact ordered selection or explicit whole source. '
      + 'Keep requestId and input on retry; a request is not consent or evidence of historical ownership.',
    inputSchema: RetainedImportChallengeInputSchema },
  { name: 'retained_import_grants_list', method: 'listGrants', service: 'listRetainedImportGrants',
    title: 'List retained import grants', scope: 'coding_sessions_read', effect: 'read', retry: 'read_again',
    description: 'List your bounded retained-import grant reviews for one accessible computer; returns no lease tokens.',
    inputSchema: computer },
  { name: 'retained_import_grant_get', method: 'readGrant', service: 'readRetainedImportGrant',
    title: 'Read retained import grant', scope: 'coding_sessions_read', effect: 'read', retry: 'read_again',
    description: 'Read your exact import grant status, original ordered selection and review location.',
    inputSchema: grant },
  { name: 'retained_import_grant_revoke', method: 'revokeGrant', service: 'revokeRetainedImportGrant',
    title: 'Revoke retained import grant', scope: 'coding_sessions_execute', effect: 'delete', retry: 'same_target_id',
    description: 'Withdraw your exact import grant. Repeating this target reconciles revocation; never creates a grant.',
    inputSchema: grant },
] as const).map(operation => ({ ...operation, kind: 'finite' as const }))

export type RetainedImportToolOperation = typeof RETAINED_IMPORT_TOOL_OPERATIONS[number]
export type RetainedImportToolMethod = RetainedImportToolOperation['method']

const issuerReview = (raw: unknown) => {
  const review = RetainedIssuerReviewSchema.parse(raw)
  const c = review.challenge
  if (review.enrollmentId !== c.enrollmentId) throw new Error('RETAINED_TOOL_RESULT_MISMATCH')
  return { enrollmentId: review.enrollmentId, status: review.status,
    source: RetainedIssuerSourceSchema.parse(Object.fromEntries(
      Object.keys(RetainedIssuerSourceSchema.shape).map(key => [key, c[key as keyof typeof c]]))),
    keyId: c.keyId, expiresAtMs: c.expiresAtMs,
    delegation: review.delegation, historicalOwnership: review.historicalOwnership,
    reviewPath: retainedIssuerReviewPath(c.executorId, review.enrollmentId) }
}

const importRequest = (raw: unknown) => {
  const c = RetainedImportChallengeSchema.parse(raw)
  return { grantId: c.challengeId, requestId: c.requestId, issuerEnrollmentId: c.issuerEnrollmentId,
    source: RetainedImportSourceSchema.parse(Object.fromEntries(
      Object.keys(RetainedImportSourceSchema.shape).map(key => [key, c[key as keyof typeof c]]))),
    generation: c.grantGeneration, selection: c.selection, expiresAtMs: c.expiresAtMs,
    basis: 'prospective_import' as const, legacyCopyProvenance: c.acceptedBaseline,
    historicalOwnership: 'unproven' as const, reviewPath: retainedImportGrantPath(c.executorId, c.challengeId) }
}

const grantReview = (raw: unknown) => {
  const review = RetainedImportGrantReviewSchema.parse(raw)
  if (review.grantId !== review.challenge.challengeId || review.generation !== review.challenge.grantGeneration
    || JSON.stringify(review.selection) !== JSON.stringify(review.challenge.selection)) {
    throw new Error('RETAINED_TOOL_RESULT_MISMATCH')
  }
  return { ...importRequest(review.challenge), grantId: review.grantId, generation: review.generation,
    status: review.status, selection: review.selection, expiresAtMs: review.expiresAtMs,
    legacyCopyProvenance: review.legacyCopyProvenance }
}

/** Validate canonical results, then project metadata; never return challenge/nonce/key/recipient or lease proof. */
export const projectRetainedImportToolResult = (method: RetainedImportToolMethod, raw: unknown) => {
  switch (method) {
    case 'discover': {
      const data = RetainedIssuerDiscoverySchema.parse(raw)
      if (data.offers.length > 100 || data.enrollments.length > 100) throw new Error('RETAINED_TOOL_RESULT_TOO_LARGE')
      return { offers: data.offers.map(offer => ({ offerId: offer.offerId,
        source: RetainedIssuerSourceSchema.parse(Object.fromEntries(
          Object.keys(RetainedIssuerSourceSchema.shape).map(key => [key, offer[key as keyof typeof offer]]))),
        keyId: offer.keyId, expiresAtMs: offer.expiresAtMs,
        reviewPath: retainedIssuerReviewPath(offer.executorId) })), enrollments: data.enrollments.map(issuerReview),
      maxItemsPerList: 100 }
    }
    case 'requestIssuer': case 'readIssuer': case 'revokeIssuer': return issuerReview(raw)
    case 'requestImport': return importRequest(raw)
    case 'listGrants': return z.array(RetainedImportGrantReviewSchema).max(100).parse(raw).map(grantReview)
    case 'readGrant': return grantReview(raw)
    case 'revokeGrant': return z.object({ grantId: z.string().uuid(), status: z.literal('revoked') }).strict().parse(raw)
    default: throw new Error('RETAINED_TOOL_OPERATION_UNKNOWN')
  }
}
