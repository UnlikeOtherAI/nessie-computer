import { createHash } from 'node:crypto'
import { canonicalExecutorJson, ExecutorManagedSessionEvidenceSchema,
  executorCodingSessionResultScope, executorManagedSessionEvidenceInput,
  type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const refused = () => new Error('Original session result authority is unavailable')

/** Runs in memory before image/attachment sinks or command result journals receive anything. */
export const validateScopedCodingResult = (
  raw: Record<string, unknown>, authority: ExecutorCodingSessionAuthority,
): Record<string, unknown> => {
  if (Date.parse(authority.expiresAt) <= Date.now() || !Array.isArray(raw.content) || raw.content.length !== 1) throw refused()
  const first = raw.content[0]
  if (!record(first) || first.type !== 'text' || typeof first.text !== 'string') throw refused()
  let body: unknown
  try { body = JSON.parse(first.text) } catch { throw refused() }
  if (!record(body) || canonicalExecutorJson(body.resultScope)
    !== canonicalExecutorJson(executorCodingSessionResultScope(authority))) throw refused()
  // Error details never cross this boundary, even when a server attached a structurally correct scope.
  if (raw.isError === true) return { isError: true, content: [{ type: 'text', text: JSON.stringify({
    code: 'coding_session_call_refused', message: 'The session operation was refused.', resultScope: body.resultScope,
  }) }] }
  const allowed = new Set(authority.admissions.map(row => row.sessionId))
  if (authority.operation === 'session_start') {
    const parsed = ExecutorManagedSessionEvidenceSchema.safeParse(body.startEvidence)
    if (!parsed.success || parsed.data.executorId !== authority.executorId
      || parsed.data.originalOwnerGeneration !== authority.originalOwnerGeneration
      || parsed.data.ownerKey !== authority.ownerKey || parsed.data.startCommandId !== authority.commandId
      || parsed.data.sessionId !== body.sessionId || body.startPhase !== 'request_and_host_created'
      || parsed.data.evidenceDigest !== createHash('sha256')
        .update(executorManagedSessionEvidenceInput(parsed.data)).digest('hex')) throw refused()
    allowed.add(parsed.data.sessionId)
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const row of value) visit(row); return }
    if (!record(value)) return
    if ('sessionId' in value && (typeof value.sessionId !== 'string' || !allowed.has(value.sessionId))) throw refused()
    for (const [key, row] of Object.entries(value)) if (key !== 'resultScope') visit(row)
  }
  visit(body)
  if (authority.operation === 'session_list') {
    if (!Array.isArray(body.sessions) || body.sessions.length !== allowed.size) throw refused()
    const seen = new Set<string>()
    for (const row of body.sessions) {
      if (!record(row) || typeof row.sessionId !== 'string' || seen.has(row.sessionId)) throw refused()
      seen.add(row.sessionId)
    }
  }
  return raw
}
