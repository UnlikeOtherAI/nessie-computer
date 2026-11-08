import { z } from 'zod'

const uuid = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const ownerKey = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const acceptedPairing = z.object({ kind: z.enum(['enrollment', 'code']), id: uuid }).strict()

/** References from an actual accepted pairing/claim, never a caller-selected compatibility mode. */
export const ExecutorSessionPairingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bound'), executorId: uuid, acceptedPairing,
    machinePublicKeyDigest: digest, originalOwnerGeneration: uuid,
  }).strict(),
  z.object({ kind: z.literal('unbound_local'), executorId: uuid, acceptedPairing,
    machinePublicKeyDigest: digest,
  }).strict(),
])
export type ExecutorSessionPairingSource = z.infer<typeof ExecutorSessionPairingSourceSchema>

/** Structural accepted-start evidence. Its digest is neither a MAC nor independently spendable authority. */
export const ExecutorManagedSessionEvidenceSchema = z.object({
  kind: z.literal('managed_start'), executorId: uuid, originalOwnerGeneration: uuid,
  ownerKey, sessionId: uuid, startCommandId: uuid, evidenceDigest: digest,
}).strict()
export type ExecutorManagedSessionEvidence = z.infer<typeof ExecutorManagedSessionEvidenceSchema>

export const executorManagedSessionEvidenceInput = (evidence: Omit<ExecutorManagedSessionEvidence, 'evidenceDigest'>) =>
  JSON.stringify([evidence.kind, evidence.executorId, evidence.originalOwnerGeneration,
    evidence.ownerKey, evidence.sessionId, evidence.startCommandId])

export const ExecutorCodingSessionOperationSchema = z.enum([
  'session_start', 'session_list', 'session_status', 'terminal_read', 'session_send',
  'session_interrupt', 'session_close', 'session_review', 'session_answer', 'session_view', 'session_user_action',
])
export type ExecutorCodingSessionOperation = z.infer<typeof ExecutorCodingSessionOperationSchema>

/** Server-derived exact selection, reconsumed at delivery. Not a model argument or serialized class receipt. */
export const ExecutorCodingSessionAuthoritySchema = z.object({
  version: z.literal(1), executorId: uuid, originalOwnerGeneration: uuid, ownerKey,
  commandId: uuid, operation: ExecutorCodingSessionOperationSchema,
  purpose: z.enum(['read', 'control']), issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  connectionEpoch: z.string().regex(/^\d+$/u), authorizationRevision: z.number().int().positive(),
  filter: z.object({ provider: z.enum(['claude', 'codex', 'terminal']).optional(),
    search: z.string().min(1).max(200).optional() }).strict(),
  admissions: z.array(ExecutorManagedSessionEvidenceSchema).max(32),
  /** A keyset continuation for data selection only; the next request must prepare its own authority. */
  nextCursor: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>()
  for (const row of value.admissions) {
    if (row.executorId !== value.executorId || row.originalOwnerGeneration !== value.originalOwnerGeneration
      || row.ownerKey !== value.ownerKey || ids.has(row.sessionId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Conflicting managed-session selection.' })
    }
    ids.add(row.sessionId)
  }
  if (value.operation === 'session_start' ? value.admissions.length !== 0
    : value.operation !== 'session_list' && value.admissions.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Operation requires an exact managed-session selection.' })
  }
  const start = Date.parse(value.issuedAt), end = Date.parse(value.expiresAt)
  const read = ['session_list', 'session_status', 'terminal_read', 'session_view'].includes(value.operation)
  if (value.purpose !== (read ? 'read' : 'control')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Session operation purpose mismatch.' })
  }
  if (end <= start || end - start > 30_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid session-authority lifetime.' })
  }
})
export type ExecutorCodingSessionAuthority = z.infer<typeof ExecutorCodingSessionAuthoritySchema>

/** This acknowledgement describes the exact executed selection; fresh admission is still required to publish it. */
export const executorCodingSessionResultScope = (scope: ExecutorCodingSessionAuthority) => ({
  version: scope.version, executorId: scope.executorId, originalOwnerGeneration: scope.originalOwnerGeneration,
  ownerKey: scope.ownerKey, commandId: scope.commandId, operation: scope.operation, purpose: scope.purpose,
  connectionEpoch: scope.connectionEpoch, authorizationRevision: scope.authorizationRevision,
  filter: scope.filter, admissions: scope.admissions,
})
