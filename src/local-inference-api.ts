import { LocalCliHostResponseSchema, PersonalInferenceReceiptStatusSchema } from '@nessie/executor-protocol'
import type {
  LocalCliHostRequest,
  LocalCliHostResponse,
  LocalInferenceAttemptControlState,
  LocalInferenceAttemptPoll,
  LocalInferenceAttemptRequest,
  LocalInferenceResult,
  LocalInferenceSignedEnvelope,
  ObservedLocalModel,
  LocalInferenceResourceControl,
  LocalInferenceResourceSync,
  LocalInferenceResourceAdmission,
  LocalInferenceTermination,
  PersonalInferenceReceiptStatus,
} from '@nessie/executor-protocol'

const REQUEST_TIMEOUT_MS = 25_000

type LocalInferenceApiFetch = (url: string, init: RequestInit) => Promise<Response>

export type LocalInferenceAttemptLease = {
  admission: LocalInferenceResourceAdmission | null
  attempt: LocalInferenceAttemptRequest | null
  dispatchFence: number | null
}

export type LocalInferenceFrame = {
  attemptId: string
  data: string
  dispatchFence: number
  final: boolean
  sequence: number
}

export type LocalInferenceResultReceipt = {
  attemptId: string
  dispatchFence: number
  result: LocalInferenceResult
}

export type LocalInferenceAttemptControl = {
  attemptId: string
  dispatchFence: number
}

/**
 * Everything a host does once connected, over its one socket. Bodies are
 * plain: the socket signs each message for its connection. A frame is sent
 * and forgotten; the sealed receipt is what Nessie keeps.
 */
export type LocalInferenceHostTransport = {
  attachResource: (resource: LocalInferenceResourceSync) => Promise<LocalInferenceResourceControl>
  accept: (control: LocalInferenceAttemptControl) => Promise<{ state: LocalInferenceAttemptControlState }>
  claim: (poll: LocalInferenceAttemptPoll) => Promise<LocalInferenceAttemptLease>
  frame: (frame: LocalInferenceFrame) => void
  heartbeat: (heartbeat: { inventory: ObservedLocalModel[]; paused: boolean; displayLabel?: string })
    => Promise<{ serverTime: string }>
  result: (receipt: LocalInferenceResultReceipt) => Promise<{ acknowledged: true }>
  terminate: (termination: LocalInferenceTermination) => Promise<{ acknowledged: true }>
}

/** The few one-off signed requests that stay plain HTTPS: before the socket, and at exit. */
export type LocalInferenceDaemonApi = {
  receiptStatus: (input: {
    envelope: LocalInferenceSignedEnvelope; receipt: LocalInferenceResultReceipt
  }) => Promise<PersonalInferenceReceiptStatus>
  resultReceipt: (input: {
    envelope: LocalInferenceSignedEnvelope; receipt: LocalInferenceResultReceipt
  }) => Promise<{ acknowledged: true }>
  terminationReceipt: (input: {
    envelope: LocalInferenceSignedEnvelope; termination: LocalInferenceTermination
  }) => Promise<{ acknowledged: true }>
  claim: (input: { challenge: string; envelope: LocalInferenceSignedEnvelope }) => Promise<{
    connectionEpoch: string
    serverTime: string
  }>
  issueChallenge: (input: { hostId: string }) => Promise<{ challenge: string; expiresAt: string }>
  /** A Claude Code or Codex engine connection's host (docs/local-cli-engines.md); an older Nessie answers 404. */
  registerCliHost: (input: LocalCliHostRequest) => Promise<LocalCliHostResponse>
  goodbye: (input: {
    envelope: LocalInferenceSignedEnvelope; goodbye: { reason: 'desktop_exit' | 'executor_shutdown'; receipt: string }
  }) => Promise<{ acknowledged: true }>
}

export class LocalInferenceApiError extends Error {
  override readonly name = 'LocalInferenceApiError'

  constructor(readonly code: string, readonly status?: number, readonly transportCode?: string) {
    super(code)
  }
}

/** The paired API origin, refused unless it is HTTPS or the explicit development loopback. */
export const localInferenceApiUrl = (baseUrl: string, path: string): URL => {
  const base = new URL(baseUrl)
  const developmentLoopback = process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1'
    && base.protocol === 'http:'
    && ['127.0.0.1', '::1', 'localhost'].includes(base.hostname)
  if (base.protocol !== 'https:' && !developmentLoopback) {
    throw new Error('Local inference requires an HTTPS API origin.')
  }
  return new URL(path, base)
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const TRANSPORT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
])

/** Keep only a closed transport diagnostic; exception messages may contain private URLs. */
export const localInferenceTransportCode = (error: unknown): string | undefined => {
  const record = asRecord(error)
  const code = record?.code ?? asRecord(record?.cause)?.code
  return typeof code === 'string' && TRANSPORT_CODES.has(code) ? code : undefined
}

const responseData = <T>(value: unknown): T => {
  const record = asRecord(value)
  if (record?.data === undefined) {
    const error = asRecord(record?.error)
    throw new LocalInferenceApiError(typeof error?.code === 'string' ? error.code : 'LOCAL_INFERENCE_API_INVALID')
  }
  return record.data as T
}

/**
 * Typed HTTPS transport for the daemon's one-off requests only. It exposes no
 * method/path/header supplied by model data, and it rejects a non-TLS API
 * origin before a request can leave the device.
 */
export const createLocalInferenceDaemonApi = (input: {
  apiBaseUrl: string
  fetchImpl?: LocalInferenceApiFetch
  requestTimeoutMs?: number
}): LocalInferenceDaemonApi => {
  const fetchImpl = input.fetchImpl ?? ((url, init) => {
    // The paired API origin is validated when executor state is created. This
    // transport subsequently permits HTTPS only, apart from the explicit
    // development-loopback switch above, so the generic SSRF transport cannot
    // be used here (it rightly rejects loopback).
    // eslint-disable-next-line no-restricted-globals -- constrained paired API transport
    return fetch(url, init)
  })
  const timeoutMs = input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Local inference request timeout is invalid.')

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(localInferenceApiUrl(input.apiBaseUrl, path).toString(), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        throw new LocalInferenceApiError('LOCAL_INFERENCE_API_INVALID', response.status)
      }
      if (!response.ok) {
        const payload = asRecord(parsed)
        const error = asRecord(payload?.error)
        throw new LocalInferenceApiError(
          typeof error?.code === 'string' ? error.code : 'LOCAL_INFERENCE_API_FAILED',
          response.status,
        )
      }
      return responseData<T>(parsed)
    } catch (error) {
      if (error instanceof LocalInferenceApiError) throw error
      if (controller.signal.aborted) throw new LocalInferenceApiError('LOCAL_INFERENCE_API_TIMEOUT')
      throw new LocalInferenceApiError('LOCAL_INFERENCE_API_UNREACHABLE', undefined, localInferenceTransportCode(error))
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    claim: (body) => post('/api/local-inference/daemon/claim', body),
    issueChallenge: (body) => post('/api/local-inference/daemon/challenge', body),
    registerCliHost: async (body) => LocalCliHostResponseSchema.parse(
      await post('/api/local-inference/daemon/executor-cli-host', body)),
    goodbye: (body) => post('/api/local-inference/daemon/goodbye', body),
    receiptStatus: async body => PersonalInferenceReceiptStatusSchema.parse(
      await post('/api/local-inference/daemon/receipts/status', body)),
    resultReceipt: (body) => post('/api/local-inference/daemon/receipts/result', body),
    terminationReceipt: (body) => post('/api/local-inference/daemon/receipts/termination', body),
  }
}
