import { createHash } from 'node:crypto'
import { requireCapture } from '../state/sqlite.js'

export interface RetainedImportChallengeV1 {
  readonly version: 1
  readonly challengeId: string
  readonly nonce: string
  readonly executorId: string
  readonly requestId: string
  readonly environmentId: string; readonly admittedRootKey: string; readonly physicalRootKey: string
  readonly databaseIdentity: string; readonly environmentIdentity: string
  readonly organizationId: string; readonly teamId: string
  readonly recipient: {
    readonly subject: string; readonly organizationId: string; readonly teamId: string
  }
  readonly selection: { readonly kind: 'whole_source' } | {
    readonly kind: 'threads'; readonly threadIds: readonly string[]; readonly projectIds: readonly string[]
  }
  readonly purpose: 'retained-import-read-publish'
  readonly grantGeneration: string
  readonly issuerEnrollmentId: string
  readonly issuerKeyId: string
  readonly captureGeneration: string
  readonly acceptedBaseline: 'not_attested_by_original_source'
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly grantExpiresAtMs: number
}
export interface RetainedImportApprovalReceiptV1 {
  readonly version: 1
  readonly kind: 'native-source-owner-consent'
  readonly challengeId: string
  readonly challengeDigest: string
  readonly receiptId: string
  readonly issuerInstance: string
  readonly issuerKeyId: string
  readonly nativeSignature: string
  readonly expiresAtMs: number
}
const valid: (condition: unknown) => asserts condition = condition =>
  requireCapture(condition, 'retained_import_challenge_invalid')
const keys = (value: unknown, expected: readonly string[]): Record<string, unknown> => {
  valid(value && typeof value === 'object' && !Array.isArray(value))
  valid(Object.keys(value).sort().join(',') === [...expected].sort().join(','))
  return value as Record<string, unknown>
}
const identifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
const uuid = (value: unknown) => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)

/** Structural parsing only; this cannot authorize approval or issue a receipt. */
export function parseRetainedImportChallenge(value: unknown, now = Date.now()): RetainedImportChallengeV1 {
  const c = keys(value, ['version', 'challengeId', 'nonce', 'executorId', 'requestId', 'environmentId',
    'admittedRootKey', 'physicalRootKey', 'databaseIdentity', 'environmentIdentity', 'organizationId', 'teamId',
    'recipient', 'selection', 'purpose', 'grantGeneration', 'captureGeneration', 'acceptedBaseline',
    'issuedAtMs', 'expiresAtMs', 'grantExpiresAtMs', 'issuerEnrollmentId', 'issuerKeyId'])
  valid(c.version === 1 && uuid(c.challengeId) && uuid(c.executorId) && uuid(c.grantGeneration))
  valid(uuid(c.issuerEnrollmentId) && typeof c.issuerKeyId === 'string' && /^[a-f0-9]{64}$/u.test(c.issuerKeyId))
  valid(typeof c.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(c.nonce)
    && Buffer.from(c.nonce, 'base64url').length === 32
    && Buffer.from(c.nonce, 'base64url').toString('base64url') === c.nonce)
  valid(['requestId', 'environmentId', 'admittedRootKey', 'physicalRootKey', 'databaseIdentity',
    'environmentIdentity', 'organizationId', 'teamId'].every(key => identifier(c[key])))
  const recipient = keys(c.recipient, ['subject', 'organizationId', 'teamId'])
  valid(Object.values(recipient).every(identifier))
  const scope = c.selection as Record<string, unknown> | undefined
  valid(scope && (scope.kind === 'whole_source' || scope.kind === 'threads'))
  keys(scope, scope.kind === 'whole_source' ? ['kind'] : ['kind', 'threadIds', 'projectIds'])
  if (scope.kind === 'threads') {
    valid(Array.isArray(scope.threadIds) && scope.threadIds.length > 0 && scope.threadIds.length <= 64
      && scope.threadIds.every(identifier) && new Set(scope.threadIds).size === scope.threadIds.length)
    valid(Array.isArray(scope.projectIds) && scope.projectIds.length <= 64
      && scope.projectIds.every(identifier) && new Set(scope.projectIds).size === scope.projectIds.length)
  }
  valid(c.purpose === 'retained-import-read-publish' && identifier(c.grantGeneration) && identifier(c.captureGeneration)
    && c.acceptedBaseline === 'not_attested_by_original_source')
  valid(typeof c.issuedAtMs === 'number' && Number.isSafeInteger(c.issuedAtMs) && c.issuedAtMs > 0
    && typeof c.expiresAtMs === 'number' && Number.isSafeInteger(c.expiresAtMs)
    && c.issuedAtMs <= now && c.expiresAtMs > now && c.expiresAtMs - c.issuedAtMs <= 300_000
    && typeof c.grantExpiresAtMs === 'number' && Number.isSafeInteger(c.grantExpiresAtMs)
    && c.grantExpiresAtMs > now && c.grantExpiresAtMs <= c.expiresAtMs)
  const parsed = JSON.parse(JSON.stringify(c)) as RetainedImportChallengeV1
  Object.freeze(parsed.recipient)
  if (parsed.selection.kind === 'threads') {
    Object.freeze(parsed.selection.threadIds); Object.freeze(parsed.selection.projectIds)
  }
  Object.freeze(parsed.selection)
  return Object.freeze(parsed)
}

/** Ordered tuple shared with native. Scope order is never sorted or inferred. */
export function retainedImportChallengeDigest(c: RetainedImportChallengeV1): string {
  const r = c.recipient
  return createHash('sha256').update(JSON.stringify(['nessie-retained-import-challenge-v1', c.version,
    c.challengeId, c.nonce, c.requestId, c.executorId, c.environmentId, c.admittedRootKey, c.physicalRootKey,
    c.databaseIdentity, c.environmentIdentity, c.organizationId, c.teamId, r.subject, r.organizationId, r.teamId,
    c.selection.kind, c.selection.kind === 'threads' ? c.selection.threadIds : [],
    c.selection.kind === 'threads' ? c.selection.projectIds : [], c.purpose, c.grantGeneration,
    c.captureGeneration, c.acceptedBaseline, c.issuedAtMs, c.expiresAtMs, c.grantExpiresAtMs,
    c.issuerEnrollmentId, c.issuerKeyId])).digest('hex')
}

export function parseRetainedImportReceipt(value: unknown, c: RetainedImportChallengeV1): RetainedImportApprovalReceiptV1 {
  const r = keys(value, ['version', 'kind', 'challengeId', 'challengeDigest', 'receiptId', 'issuerInstance',
    'expiresAtMs', 'issuerKeyId', 'nativeSignature'])
  valid(r.version === 1 && r.kind === 'native-source-owner-consent' && r.challengeId === c.challengeId
    && r.challengeDigest === retainedImportChallengeDigest(c) && r.expiresAtMs === c.expiresAtMs
    && typeof r.receiptId === 'string' && /^[a-f0-9]{64}$/u.test(r.receiptId)
    && typeof r.issuerInstance === 'string' && /^[a-f0-9]{64}$/u.test(r.issuerInstance)
    && r.issuerKeyId === c.issuerKeyId && signature(r.nativeSignature))
  return Object.freeze({ ...r }) as unknown as RetainedImportApprovalReceiptV1
}

export interface RetainedImportVerificationV1 {
  readonly verificationId: string
  readonly nonce: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}
export interface RetainedImportLiveProofV1 {
  readonly version: 1
  readonly operation: 'consume' | 'recheck' | 'revoke'
  readonly verification: RetainedImportVerificationV1
  readonly issuerKeyId: string
  readonly issuerInstance: string
  readonly receiptId: string
  readonly challengeDigest: string
  readonly consumptionId: string
  readonly observedAtMs: number
  readonly expiresAtMs: number
  readonly nativeSignature: string
}
function signature(value: unknown): boolean {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === 64
    && Buffer.from(value, 'base64').toString('base64') === value
}
export function parseRetainedImportVerification(value: unknown, c: RetainedImportChallengeV1,
  now = Date.now()): RetainedImportVerificationV1 {
  const v = keys(value, ['verificationId', 'nonce', 'issuedAtMs', 'expiresAtMs'])
  valid(uuid(v.verificationId) && typeof v.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(v.nonce)
    && Buffer.from(v.nonce, 'base64url').toString('base64url') === v.nonce)
  valid(typeof v.issuedAtMs === 'number' && Number.isSafeInteger(v.issuedAtMs) && v.issuedAtMs > 0
    && v.issuedAtMs <= now && typeof v.expiresAtMs === 'number' && Number.isSafeInteger(v.expiresAtMs)
    && v.expiresAtMs > now && v.expiresAtMs <= c.grantExpiresAtMs)
  return Object.freeze({ ...v }) as unknown as RetainedImportVerificationV1
}
/** Structural binding only. The backend verifies with its previously enrolled key. */
export function parseRetainedImportLiveProof(value: unknown, c: RetainedImportChallengeV1,
  r: RetainedImportApprovalReceiptV1, verification: RetainedImportVerificationV1,
  operation: RetainedImportLiveProofV1['operation'], consumptionId: string): RetainedImportLiveProofV1 {
  const p = keys(value, ['version', 'operation', 'verification', 'issuerKeyId', 'issuerInstance', 'receiptId',
    'challengeDigest', 'consumptionId', 'observedAtMs', 'expiresAtMs', 'nativeSignature'])
  const v = parseRetainedImportVerification(p.verification, c)
  valid(p.version === 1 && p.operation === operation && p.issuerKeyId === r.issuerKeyId
    && p.issuerInstance === r.issuerInstance && p.receiptId === r.receiptId && p.challengeDigest === r.challengeDigest
    && p.consumptionId === consumptionId && signature(p.nativeSignature)
    && v.verificationId === verification.verificationId && v.nonce === verification.nonce
    && v.issuedAtMs === verification.issuedAtMs && v.expiresAtMs === verification.expiresAtMs
    && typeof p.observedAtMs === 'number' && Number.isSafeInteger(p.observedAtMs)
    && p.observedAtMs >= v.issuedAtMs && p.observedAtMs <= Date.now()
    && p.expiresAtMs === v.expiresAtMs && p.observedAtMs < v.expiresAtMs)
  return Object.freeze({ ...p, verification: v }) as unknown as RetainedImportLiveProofV1
}
