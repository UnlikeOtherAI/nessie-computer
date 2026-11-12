import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { decodeJwt, importJWK, jwtVerify, type JWK } from 'jose'
import { safeFetch, type PinnedFetch } from '@nessie/executor-support/url-safety'

export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
/** The public personal-agent client also used by Codex and OpenClaw. This is not a client secret. */
export const CHATGPT_PERSONAL_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_PERSONAL_SCOPES = 'openid profile email offline_access'
export const CHATGPT_CALLBACK_PATH = '/auth/callback'
export class ChatgptAuthError extends Error {
  override readonly name = 'ChatgptAuthError'
  constructor(readonly code: string) { super(code) }
}
const refuse = (code: string): never => { throw new ChatgptAuthError(code) }
export const randomOAuthValue = (): string => randomBytes(48).toString('base64url')
export const sameOAuthValue = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
export const issuedChatgptClient = (value: unknown): value is string => typeof value === 'string'
  && value !== 'dynamic_agent_client' && /^[A-Za-z0-9_-]{1,200}$/u.test(value)

export type ChatgptTokens = {
  idToken: string; accessToken: string | null; refreshToken: string | null
  expiresAt: number | null; scopes: string[]; subject: string; issuer: typeof CHATGPT_ISSUER
  accountId?: string
}
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string
  revocation_endpoint: string }
export type ChatgptOAuthRequest = {
  clientId: string | null; hostId: string; redirectUri: string; state: string; nonce: string
  verifier: string; idTokenHint?: string
}

/** All provider URLs are OpenAI-owned. Injection changes only the HTTP adapter in deterministic tests. */
export class ChatgptOAuthProvider {
  private configuration?: { expires: number; value: Discovery }
  private keys?: { expires: number; value: JWK[] }
  constructor(
    private readonly fetcher: PinnedFetch = (url, init) =>
      safeFetch(url.toString(), init, { credentialsPresent: true, maxRedirects: 0 }),
    private readonly now: () => number = Date.now,
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const parsed = new URL(url)
    if (parsed.origin !== CHATGPT_ISSUER || parsed.username || parsed.password || parsed.hash) {
      return refuse('oauth_endpoint_invalid')
    }
    const response = await this.fetcher(parsed, { ...init, redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) })
    const chunks: Uint8Array[] = []
    const reader = response.body?.getReader()
    let size = 0
    if (!reader) return refuse('oauth_response_invalid')
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 128 * 1024) { await reader.cancel(); return refuse('oauth_response_invalid') }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    let value: Record<string, unknown>
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
    catch { return refuse('oauth_response_invalid') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('oauth_response_invalid')
    if (!response.ok) {
      // Only stable protocol codes leave this boundary, never provider text/body.
      const code = typeof value.error === 'string' ? value.error : ''
      const terminal = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
        'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client']
      refuse(terminal.includes(code) ? code : 'oauth_provider_unavailable')
    }
    return value
  }

  private async discovery(signal?: AbortSignal): Promise<Discovery> {
    if (this.configuration && this.configuration.expires > this.now()) return this.configuration.value
    const value = await this.request(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { signal })
    if (value.issuer !== CHATGPT_ISSUER
      || value.authorization_endpoint !== `${CHATGPT_ISSUER}/api/accounts/authorize`
      || value.token_endpoint !== `${CHATGPT_ISSUER}/api/accounts/oauth/token`) refuse('oauth_discovery_invalid')
    for (const field of ['jwks_uri', 'revocation_endpoint']) {
      if (typeof value[field] !== 'string' || new URL(value[field] as string).origin !== CHATGPT_ISSUER) {
        refuse('oauth_discovery_invalid')
      }
    }
    this.configuration = { value: value as unknown as Discovery, expires: this.now() + 300_000 }
    return this.configuration.value
  }

  async authorizationUrl(input: ChatgptOAuthRequest): Promise<string> {
    const personal = !input.clientId || input.clientId === CHATGPT_PERSONAL_CLIENT_ID
    const authorization_endpoint = personal ? `${CHATGPT_ISSUER}/oauth/authorize`
      : (await this.discovery()).authorization_endpoint
    const redirect = new URL(input.redirectUri)
    if (redirect.protocol !== 'http:' || !['127.0.0.1', ...(personal ? ['localhost'] : [])].includes(redirect.hostname)
      || redirect.pathname !== CHATGPT_CALLBACK_PATH || redirect.search || redirect.hash || !redirect.port) {
      return refuse('oauth_callback_invalid')
    }
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({ client_id: input.clientId ?? CHATGPT_PERSONAL_CLIENT_ID,
      ...(personal ? { originator: 'nessie-computer', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' }
        : { ext_agent_host_id: input.hostId, resource: CHATGPT_RESOURCE }),
      response_type: 'code', redirect_uri: input.redirectUri, scope: personal ? CHATGPT_PERSONAL_SCOPES : CHATGPT_SCOPES,
      state: input.state, nonce: input.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(input.verifier).digest('base64url'),
      ...(input.clientId && input.idTokenHint ? { id_token_hint: input.idTokenHint } : {}),
    }).toString()
    return url.toString()
  }

  async verifyIdentity(idToken: string, clientId: string, nonce?: string, expectedSubject?: string,
    signal?: AbortSignal): Promise<string> {
    if (idToken.length > 64 * 1024 || !issuedChatgptClient(clientId)) return refuse('oauth_identity_invalid')
    const discovery = await this.discovery(signal)
    let refreshed = false
    try {
      const verified = await jwtVerify(idToken, async (header) => {
        if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') refuse('oauth_identity_invalid')
        if (!this.keys || this.keys.expires <= this.now()) {
          const value = await this.request(discovery.jwks_uri, { signal })
          if (!Array.isArray(value.keys) || value.keys.length > 32) refuse('oauth_identity_invalid')
          this.keys = { value: value.keys as JWK[], expires: this.now() + 300_000 }
        }
        let key = this.keys!.value.find((candidate) => candidate.kid === header.kid)
        if (!key && !refreshed) {
          refreshed = true
          this.keys = undefined
          const value = await this.request(discovery.jwks_uri, { signal })
          if (!Array.isArray(value.keys) || value.keys.length > 32) refuse('oauth_identity_invalid')
          this.keys = { value: value.keys as JWK[], expires: this.now() + 300_000 }
          key = this.keys.value.find((candidate) => candidate.kid === header.kid)
        }
        if (!key || key.d || key.use && key.use !== 'sig' || key.alg && key.alg !== header.alg
          || key.key_ops && !key.key_ops.includes('verify')) return refuse('oauth_identity_invalid')
        return importJWK(key, header.alg)
      }, { issuer: discovery.issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5, currentDate: new Date(this.now()), algorithms: ['RS256', 'ES256'] })
      const { sub } = verified.payload
      if (typeof sub !== 'string' || !sub || sub.length > 512
        || typeof verified.payload.iat !== 'number' || verified.payload.iat > this.now() / 1_000 + 5
        || verified.payload.azp !== undefined && verified.payload.azp !== clientId
        || Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1
          && verified.payload.azp !== clientId
        || nonce !== undefined && verified.payload.nonce !== nonce
        || expectedSubject !== undefined && sub !== expectedSubject) return refuse('oauth_identity_invalid')
      return sub
    } catch { return refuse('oauth_identity_invalid') }
  }

  private async tokens(value: Record<string, unknown>, clientId: string, input: {
    nonce?: string; subject?: string; previous?: ChatgptTokens; signal?: AbortSignal
  }): Promise<ChatgptTokens> {
    const idToken = typeof value.id_token === 'string' ? value.id_token : input.previous?.idToken
    if (!idToken) return refuse('oauth_identity_invalid')
    const subject = value.id_token === undefined && input.previous ? input.previous.subject
      : await this.verifyIdentity(idToken, clientId, input.nonce, input.subject, input.signal)
    const scopes = typeof value.scope === 'string' ? [...new Set(value.scope.split(' ').filter(Boolean))]
      : input.previous?.scopes ?? []
    const accessToken = typeof value.access_token === 'string' && value.access_token ? value.access_token : null
    const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token
      ? value.refresh_token : clientId === CHATGPT_PERSONAL_CLIENT_ID && value.refresh_token === undefined
        ? input.previous?.refreshToken ?? null : null
    if (input.previous && (!accessToken || !refreshToken)) return refuse('oauth_response_invalid')
    const expiresIn = value.expires_in
    if (accessToken && (value.token_type !== 'Bearer' || !Number.isSafeInteger(expiresIn) || Number(expiresIn) < 1)) {
      return refuse('oauth_response_invalid')
    }
    const personal = clientId === CHATGPT_PERSONAL_CLIENT_ID
    const auth = (personal ? decodeJwt(idToken)['https://api.openai.com/auth'] : undefined) as
      Record<string, unknown> | undefined
    const accountId = auth?.chatgpt_account_id ?? input.previous?.accountId
    if (personal && (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(accountId)
      || input.previous?.accountId && accountId !== input.previous.accountId)) return refuse('oauth_identity_invalid')
    return { idToken, subject, issuer: CHATGPT_ISSUER, scopes, accessToken, refreshToken,
      ...(personal ? { accountId: accountId as string } : {}),
      expiresAt: accessToken ? this.now() + Number(expiresIn) * 1_000 : null }
  }

  async exchange(input: { code: string; clientId: string; redirectUri: string; verifier: string
    nonce: string; subject?: string; signal?: AbortSignal }): Promise<ChatgptTokens> {
    if (!issuedChatgptClient(input.clientId)) return refuse('oauth_client_invalid')
    const personal = input.clientId === CHATGPT_PERSONAL_CLIENT_ID
    const endpoint = personal ? `${CHATGPT_ISSUER}/oauth/token` : (await this.discovery(input.signal)).token_endpoint
    const value = await this.request(endpoint, { method: 'POST', signal: input.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: input.clientId, code: input.code,
        code_verifier: input.verifier, redirect_uri: input.redirectUri,
        ...(personal ? {} : { resource: CHATGPT_RESOURCE }),
      }) })
    return this.tokens(value, input.clientId, { ...input, ...(personal ? { nonce: undefined } : {}) })
  }

  async refresh(clientId: string, previous: ChatgptTokens, signal: AbortSignal): Promise<ChatgptTokens> {
    if (!issuedChatgptClient(clientId) || !previous.refreshToken) return refuse('invalid_refresh_token')
    const personal = clientId === CHATGPT_PERSONAL_CLIENT_ID
    const endpoint = personal ? `${CHATGPT_ISSUER}/oauth/token` : (await this.discovery(signal)).token_endpoint
    const value = await this.request(endpoint, { method: 'POST', signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: clientId,
        refresh_token: previous.refreshToken, ...(personal ? {} : { resource: CHATGPT_RESOURCE }),
      }) })
    return this.tokens(value, clientId, { subject: previous.subject, previous, signal })
  }

  async revoke(clientId: string, refreshToken: string, signal: AbortSignal): Promise<boolean> {
    try {
      const discovery = await this.discovery(signal)
      const response = await this.fetcher(new URL(discovery.revocation_endpoint), { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
          token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId,
        }) })
      return response.status === 200
    } catch { return false }
  }
}

export const hasChatgptPlanPermission = (tokens: ChatgptTokens): boolean => typeof tokens.accessToken === 'string'
  && tokens.accessToken.length > 0 && Array.isArray(tokens.scopes)
  && (Boolean(tokens.accountId && tokens.refreshToken)
    || tokens.scopes.includes('chatgpt.tokens.use.direct') && tokens.scopes.includes('resource.invoke'))
