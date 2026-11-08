import type {
  ExecutorCommandAttachment,
  ExecutorDaemonCommandPollRequest,
  ExecutorDaemonCommandPollResponse,
  ExecutorCommandReceipt,
  ExecutorDaemonCommandAttachmentResponse,
  ExecutorSessionViewExchange,
  ExecutorSessionViewRequest,
  ExecutorSoftwareStatus,
  ExecutorSoftwareUpdateRequest,
} from '@nessie/executor-protocol'
import type { BrowserCookieImportOffer } from './browser-cookie-import-bridge.js'

type ApiError = { error?: { code?: string; details?: unknown; message?: string } }

/** Every daemon request's deadline, unless the request carries its own. */
export const EXECUTOR_API_REQUEST_TIMEOUT_MS = 15_000

const normalizeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/$/, '')}${path}`

export class ExecutorApiError extends Error {
  readonly code?: string
  readonly status?: number
  /** The error envelope's `details`, unparsed (folder sync's 409 carries the head). */
  readonly details?: unknown

  constructor(message: string, options: { code?: string; details?: unknown; status?: number } = {}) {
    super(message)
    this.name = 'ExecutorApiError'
    this.code = options.code
    this.status = options.status
    this.details = options.details
  }
}

/** Per-request options of the folder sync calls. */
export type ExecutorSyncRequestOptions = { signal?: AbortSignal; timeoutMs?: number }

/** A byte answer: the status, its headers and the streamed body. */
export type ExecutorSyncBytes = { body: ReadableStream<Uint8Array> | null; headers: Headers; status: number }

export type ExecutorApiClient = {
  exchangeSessionViews: (baseUrl: string, input: ExecutorSessionViewExchange) =>
    Promise<{ requests: ExecutorSessionViewRequest[] }>
  pairing: (
    baseUrl: string, action: 'start' | 'poll' | 'confirm' | 'cancel' | 'connection' | 'sign-off', input: unknown,
  ) => Promise<unknown>
  personalChatgpt: (
    baseUrl: string, action: 'challenge' | 'delegate' | 'disconnect', input: unknown,
  ) => Promise<unknown>
  cancelPending: () => void
  checkSessionAuthority: (baseUrl: string, input: import('@nessie/executor-protocol').ExecutorSessionAuthorityCheck)
    => Promise<import('@nessie/executor-protocol').ExecutorSessionAuthorityChecked>
  claim: (baseUrl: string, input: { challenge: string; executorId: string; signature: string }) =>
    Promise<{ connectionEpoch: string; status: string;
      sessionPairingSource?: import('@nessie/executor-protocol').ExecutorSessionPairingSource }>
  heartbeat: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string;
      software?: ExecutorSoftwareStatus; monitorVersion?: 1 },
  ) => Promise<{
    connectionEpoch: string; status: string; codingSessionClose?: unknown; existingSessionsAllowed?: boolean;
    softwareUpdateRequest?: ExecutorSoftwareUpdateRequest; monitorRequest?: unknown
  }>
  pollCommand: (
    baseUrl: string,
    input: Omit<ExecutorDaemonCommandPollRequest, 'executorId'> & { executorId: string },
  ) => Promise<ExecutorDaemonCommandPollResponse>
  recordCommandReceipt: (
    baseUrl: string,
    input: {
      connectionEpoch: string
      executorId: string
      receipt: ExecutorCommandReceipt
      result?: Record<string, unknown>
      signature: string
    },
  ) => Promise<{ recorded: boolean }>
  /**
   * One image of a command's result, before its receipt. It carries its own
   * deadline, because an upload's time grows with its size.
   */
  uploadCommandAttachment: (
    baseUrl: string,
    input: {
      attachment: ExecutorCommandAttachment
      connectionEpoch: string
      dataBase64: string
      executorId: string
      signature: string
    },
    options: { timeoutMs: number },
  ) => Promise<ExecutorDaemonCommandAttachmentResponse>
  issueChallenge: (baseUrl: string, executorId: string) =>
    Promise<{ challenge: string; expiresAt: string }>
  localInferenceHost: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => Promise<{ connectionEpoch: string; hostId: string; organizationId: string }>
  pollBrowserCookieImport: (
    baseUrl: string,
    input: { connectionEpoch: string; executorId: string; observedAt: string; signature: string },
  ) => Promise<{ offer: BrowserCookieImportOffer | null }>
  /** Folder sync: a signed JSON route under `/api/executor-daemon/sync/`. */
  syncPost: <T>(baseUrl: string, path: string, body: unknown, options?: ExecutorSyncRequestOptions) => Promise<T>
  /** Folder sync: a byte download; the envelope and `Range` travel in `headers`. */
  syncGetBytes: (
    baseUrl: string, path: string, headers: Record<string, string>, options?: ExecutorSyncRequestOptions,
  ) => Promise<ExecutorSyncBytes>
  /** Folder sync: one raw upload part; the envelope travels in `headers`. */
  syncPutBytes: <T>(
    baseUrl: string, path: string, headers: Record<string, string>, bytes: Uint8Array,
    options?: ExecutorSyncRequestOptions,
  ) => Promise<T>
  submitDescriptor: (
    baseUrl: string,
    input: { connectionEpoch: string; descriptor: unknown; executorId: string },
  ) => Promise<{ reviewStatus: string; revision: number }>
  submitEnrollment: (
    baseUrl: string,
    input: unknown,
  ) => Promise<{ executorId: string; fingerprint: string }>
  uploadBrowserCookieImport: (
    baseUrl: string,
    input: {
      connectionEpoch: string
      cookies: unknown
      executorId: string
      payloadDigest: string
      requestId: string
      selectedOrigins: string[]
      signature: string
      submittedAt: string
    },
  ) => Promise<{ status: 'imported' }>
}

export const createExecutorApi = (options: {
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
} = {}): ExecutorApiClient => {
  const fetchImpl = options.fetchImpl ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? EXECUTOR_API_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('Executor API request timeout must be positive and finite.')
  }
  const pending = new Set<AbortController>()

  /**
   * One request with its deadline, cancellable by `cancelPending` and by the
   * caller's own signal. Answers the raw response; the caller reads it.
   */
  const request = async <T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    read: (response: Response) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const controller = new AbortController()
    pending.add(controller)
    const timeout = setTimeout(() => controller.abort('deadline'), timeoutMs)
    const forward = () => controller.abort('cancelled')
    signal?.addEventListener('abort', forward, { once: true })
    if (signal?.aborted) controller.abort('cancelled')
    try {
      return await read(await fetchImpl(url, { ...init, signal: controller.signal }))
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason === 'deadline'
        throw new ExecutorApiError(
          timedOut ? 'Executor API request timed out.' : 'Executor API request was cancelled.',
          { code: timedOut ? 'EXECUTOR_API_TIMEOUT' : 'EXECUTOR_API_CANCELLED' },
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forward)
      pending.delete(controller)
    }
  }

  const readData = async <T>(response: Response): Promise<T> => {
    let payload: { data?: T } & ApiError
    try {
      payload = await response.json() as { data?: T } & ApiError
    } catch {
      throw new ExecutorApiError(`Executor API returned an invalid response (${response.status}).`, {
        status: response.status,
      })
    }
    if (!response.ok || payload.data === undefined) {
      throw new ExecutorApiError(
        payload.error?.message ?? `Executor API request failed (${response.status}).`,
        { code: payload.error?.code, details: payload.error?.details, status: response.status },
      )
    }
    return payload.data
  }

  const post = <T>(
    baseUrl: string,
    path: string,
    body: unknown,
    timeoutMs = requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> => request(normalizeUrl(baseUrl, path), {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }, timeoutMs, readData<T>, signal)

  return {
    exchangeSessionViews: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/session-views', input),
    pairing: (baseUrl, action, input) => post(baseUrl, `/api/executor-pairing/${action}`, input),
    personalChatgpt: (baseUrl, action, input) => post(baseUrl,
      action === 'challenge' ? '/api/local-inference/daemon/personal-challenge'
        : action === 'delegate' ? '/api/local-inference/daemon/personal-delegation'
          : '/api/local-inference/daemon/personal-disconnect', input),
    cancelPending: () => {
      for (const controller of pending) controller.abort('cancelled')
    },
    claim: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/claim', input),
    checkSessionAuthority: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/session-authority', input),
    heartbeat: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/heartbeat', input),
    pollCommand: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/commands/poll', input),
    recordCommandReceipt: (baseUrl, input) =>
      post(baseUrl, '/api/executor-daemon/commands/receipt', input),
    uploadCommandAttachment: (baseUrl, input, options) =>
      post(baseUrl, '/api/executor-daemon/commands/attachment', input, options.timeoutMs),
    issueChallenge: (baseUrl, executorId) =>
      post(baseUrl, '/api/executor-daemon/challenge', { executorId }),
    localInferenceHost: (baseUrl, input) =>
      post(baseUrl, '/api/local-inference/daemon/executor-host', input),
    pollBrowserCookieImport: (baseUrl, input) =>
      post(baseUrl, '/api/executor-daemon/browser-cookie-imports/pending', input),
    syncPost: (baseUrl, path, body, options = {}) =>
      post(baseUrl, path, body, options.timeoutMs ?? requestTimeoutMs, options.signal),
    syncGetBytes: (baseUrl, path, headers, options = {}) => request(normalizeUrl(baseUrl, path), {
      headers, method: 'GET',
    }, options.timeoutMs ?? requestTimeoutMs, async (response) => {
      if (response.ok) return { body: response.body, headers: response.headers, status: response.status }
      return readData<never>(response)
    }, options.signal),
    syncPutBytes: <T>(
      baseUrl: string, path: string, headers: Record<string, string>, bytes: Uint8Array,
      options: ExecutorSyncRequestOptions = {},
    ) => request(normalizeUrl(baseUrl, path), {
      body: bytes as Uint8Array<ArrayBuffer>, headers: { ...headers, 'content-type': 'application/octet-stream' },
      method: 'PUT',
    }, options.timeoutMs ?? requestTimeoutMs, readData<T>, options.signal),
    submitDescriptor: (baseUrl, input) => post(baseUrl, '/api/executor-daemon/descriptor', input),
    submitEnrollment: (baseUrl, input) => post(baseUrl, '/api/executor-enrollments/submit', input),
    uploadBrowserCookieImport: (baseUrl, input) =>
      post(baseUrl, '/api/executor-daemon/browser-cookie-imports/upload', input),
  }
}

export const executorApi = createExecutorApi()
