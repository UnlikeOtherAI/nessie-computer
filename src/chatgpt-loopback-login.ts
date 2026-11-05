import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  CHATGPT_CALLBACK_PATH, ChatgptOAuthProvider, issuedChatgptClient, randomOAuthValue, sameOAuthValue,
  type ChatgptTokens,
} from './chatgpt-oauth-provider.js'

export type ChatgptLoginResult =
  | { status: 'verified'; clientId: string; tokens: ChatgptTokens }
  | { status: 'failed' | 'cancelled' | 'expired'; code: string }
export type ChatgptLoopbackLogin = {
  authorizationUrl: string
  callbackUri: string
  /** Verified material remains process-local; this listener never persists it. */
  completion: Promise<ChatgptLoginResult>
  status: () => 'awaiting_browser' | 'exchanging' | ChatgptLoginResult['status']
  cancel: () => Promise<void>
}

type Provider = Pick<ChatgptOAuthProvider, 'authorizationUrl' | 'exchange'>
type Input = {
  hostId: string
  clientId?: string
  expectedSubject?: string
  idTokenHint?: string
  signal?: AbortSignal
  /** Bounded attempt lifetime, also allowing deterministic short-lived fixtures. */
  lifetimeMs?: number
}

const answer = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' })
  response.end(text)
}
const single = (query: URLSearchParams, key: string, maximum: number): string | null => {
  const values = query.getAll(key)
  return values.length === 1 && values[0]!.length > 0 && values[0]!.length <= maximum ? values[0]! : null
}

/** One browser attempt, listening only on IPv4 loopback before authorization begins. */
export const startChatgptLoopbackLogin = async (
  input: Input, provider: Provider = new ChatgptOAuthProvider(),
): Promise<ChatgptLoopbackLogin> => {
  if (input.clientId !== undefined && !issuedChatgptClient(input.clientId)) throw new Error('oauth_client_invalid')
  const lifetime = input.lifetimeMs ?? 300_000
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 600_000) throw new Error('oauth_attempt_invalid')
  input.signal?.throwIfAborted()
  const state = randomOAuthValue()
  const nonce = randomOAuthValue()
  const verifier = randomOAuthValue()
  const controller = new AbortController()
  let status: ReturnType<ChatgptLoopbackLogin['status']> = 'awaiting_browser'
  let consumed = false
  let callbackUri = ''
  let complete!: (result: ChatgptLoginResult) => void
  const completion = new Promise<ChatgptLoginResult>((resolve) => { complete = resolve })
  let timer: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    void callback(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) answer(response, 500, 'Sign-in could not be verified.')
      finish({ status: 'failed', code: 'oauth_callback_failed' })
    })
  })
  server.maxConnections = 8
  server.headersTimeout = 5_000
  server.requestTimeout = 5_000
  server.keepAliveTimeout = 1_000
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    return closing
  }
  const finish = (result: ChatgptLoginResult): void => {
    if (status !== 'awaiting_browser' && status !== 'exchanging') return
    status = result.status
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', cancelled)
    controller.abort()
    complete(result)
    // End response writes first; closing cannot leave an idle loopback socket.
    setImmediate(() => { void close() })
  }
  const cancelled = (): void => { finish({ status: 'cancelled', code: 'oauth_cancelled' }) }
  const callback = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const address = new URL(callbackUri)
    if (request.method !== 'GET' || request.socket.remoteAddress !== '127.0.0.1'
      || request.headers.host !== address.host || !request.url || request.url.length > 8_192) {
      answer(response, 400, 'Invalid sign-in callback.')
      return
    }
    const url = new URL(request.url, callbackUri)
    if (url.origin !== address.origin || url.pathname !== CHATGPT_CALLBACK_PATH || url.hash) {
      answer(response, 404, 'Sign-in callback not found.')
      return
    }
    const returnedState = single(url.searchParams, 'state', 128)
    if (!returnedState || !sameOAuthValue(returnedState, state)) {
      answer(response, 400, 'Invalid sign-in callback.')
      return
    }
    if (consumed || status !== 'awaiting_browser') {
      answer(response, 409, 'This sign-in callback was already consumed.')
      return
    }
    consumed = true
    const error = single(url.searchParams, 'error', 128)
    if (url.searchParams.has('error')) {
      answer(response, 400, 'Sign-in was not completed. Return to Nessie.')
      finish({ status: 'failed', code: error === 'access_denied' ? 'oauth_access_denied' : 'oauth_callback_failed' })
      return
    }
    const returnedClient = single(url.searchParams, 'client_id', 200)
    const clientId = input.clientId ?? returnedClient
    const code = single(url.searchParams, 'code', 4_096)
    if (!code || !clientId || !issuedChatgptClient(clientId)
      || url.searchParams.has('client_id') && returnedClient !== clientId) {
      answer(response, 400, 'Invalid sign-in registration. Return to Nessie.')
      finish({ status: 'failed', code: 'oauth_callback_invalid' })
      return
    }
    status = 'exchanging'
    try {
      const tokens = await provider.exchange({ code, clientId, redirectUri: callbackUri, verifier, nonce,
        subject: input.expectedSubject, signal: controller.signal })
      if (status !== 'exchanging' || controller.signal.aborted) return
      answer(response, 200, 'Sign-in was verified. Return to Nessie to finish connecting.')
      finish({ status: 'verified', clientId, tokens })
    } catch {
      if (status !== 'exchanging') return
      answer(response, 400, 'Sign-in could not be verified. Return to Nessie.')
      // A spent or ambiguous code is never retried by this attempt.
      finish({ status: 'failed', code: 'oauth_exchange_failed' })
    }
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { reject(error) }
    server.once('error', failed)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve() })
  })
  server.on('error', () => finish({ status: 'failed', code: 'oauth_listener_unavailable' }))
  const address = server.address()
  if (!address || typeof address === 'string') { await close(); throw new Error('oauth_listener_unavailable') }
  callbackUri = `http://127.0.0.1:${address.port}${CHATGPT_CALLBACK_PATH}`
  timer = setTimeout(() => finish({ status: 'expired', code: 'oauth_expired' }), lifetime)
  input.signal?.addEventListener('abort', cancelled, { once: true })
  if (input.signal?.aborted) cancelled()
  try {
    const authorizationUrl = await provider.authorizationUrl({ clientId: input.clientId ?? null, hostId: input.hostId,
      redirectUri: callbackUri, state, nonce, verifier,
      ...(input.idTokenHint ? { idTokenHint: input.idTokenHint } : {}) })
    controller.signal.throwIfAborted()
    return { authorizationUrl, callbackUri, completion, status: () => status,
      cancel: async () => { cancelled(); await close() } }
  } catch (error) {
    finish({ status: 'failed', code: 'oauth_authorization_unavailable' })
    await close()
    throw error
  }
}
