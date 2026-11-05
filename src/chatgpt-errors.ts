import type { LocalInferenceResult } from '@nessie/executor-protocol'

export type ChatgptFailureCode =
  | 'chatgpt_unavailable' | 'chatgpt_needs_sign_in' | 'chatgpt_usage_limit' | 'chatgpt_policy_denied'
  | 'chatgpt_unsupported_capability' | 'chatgpt_output_cap_unsupported' | 'chatgpt_model_missing'
  | 'chatgpt_protocol_error' | 'chatgpt_usage_unknown' | 'chatgpt_cancelled'

/** Closed diagnostics only. Provider bodies, account claims and tokens never escape. */
export class ChatgptError extends Error {
  override readonly name = 'ChatgptError'
  constructor(readonly code: ChatgptFailureCode, readonly outcome: 'not_sent' | 'rejected' | 'unknown',
    readonly status?: number) { super(code) }
}

export const chatgptProtocolError = (): never => { throw new ChatgptError('chatgpt_protocol_error', 'unknown') }
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const chatgptProviderFailure = (body: unknown, status?: number): ChatgptError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  const code = error?.code
  const failure = code === 'subscription_sharing_usage_limit_exceeded' || status === 429 ? 'chatgpt_usage_limit'
    : code === 'subscription_sharing_unsupported_capability' || status === 400 ? 'chatgpt_unsupported_capability'
    : status === 401 || code === 'invalid_token' ? 'chatgpt_needs_sign_in'
    : status === 403 || code === 'subscription_sharing_user_not_eligible' ? 'chatgpt_policy_denied'
    : 'chatgpt_unavailable'
  // A server timeout/5xx or an invalid error envelope cannot prove that an
  // already-sent generation was rejected. Only documented structured rejections
  // own that outcome; stream failures always retain unknown liability.
  const rejection = status !== undefined && [400, 401, 403, 429].includes(status)
    && typeof code === 'string' && code.length > 0 && code.length <= 200
  return new ChatgptError(failure, rejection ? 'rejected' : 'unknown', status)
}

/** Evidence comes only from the typed trusted HTTP/pre-POST boundary, never diagnostic strings. */
export const chatgptNonacceptanceEvidence = (error: unknown): LocalInferenceResult['personalNonacceptance'] => {
  if (!(error instanceof ChatgptError)) return undefined
  if (error.outcome === 'not_sent') return { kind: 'not_sent' as const }
  if (error.outcome !== 'rejected') return undefined
  const httpStatus = error.status
  if (httpStatus !== 400 && httpStatus !== 401 && httpStatus !== 403 && httpStatus !== 429) return undefined
  return { kind: 'rejected' as const, httpStatus, structuredError: true as const }
}
