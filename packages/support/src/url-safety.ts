import { lookup } from 'node:dns/promises'
import { connect, isIP, type Socket } from 'node:net'
import undici, { Agent, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici'

import {
  isCredentialHeaderName,
  normalizeFetchHeaders,
  planRedirect,
  resolveRedirectPolicy,
  UrlSafetyError,
  type RedirectPolicy,
  type RedirectPolicyOptions,
} from './redirect-policy.js'

export { UrlSafetyError }
export type { RedirectPolicy }

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata.google.internal',
])

const isBlockedIpv4Address = (value: string): boolean => {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return true
  }
  const first = parts[0]
  const second = parts[1]
  if (first === undefined || second === undefined) return true
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0) ||
    first >= 224
  )
}

const isBlockedIpv6Address = (value: string): boolean => {
  const normalized = value.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('2001:db8') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

const isBlockedIpAddress = (value: string): boolean => {
  const version = isIP(value)
  if (version === 4) return isBlockedIpv4Address(value)
  if (version === 6) return isBlockedIpv6Address(value)
  return true
}

export type ResolveHost = (hostname: string) => Promise<string[]>

const defaultResolveHost: ResolveHost = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => entry.address)
}

export type AssertSafeUrlOptions = {
  resolveHost?: ResolveHost
}

export type SafeUrlResolution = {
  addresses: string[]
  url: URL
}

/** Structural admission for stored discovery URLs; every dial additionally resolves and pins DNS. */
export const validatePublicHostname = (rawHostname: string): string => {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || (isIP(hostname) !== 0 && isBlockedIpAddress(hostname))) {
    throw new UrlSafetyError('Private or local network URLs are not allowed.')
  }
  return hostname
}

/**
 * Vet a bare hostname and hand back the addresses it resolved to.
 *
 * The private-range, special-use and literal-address rules live here once and
 * are shared by every outbound protocol — HTTP through `resolveAndValidate`
 * below, and IMAP/SMTP through the mail dialer, which is not URL-shaped and
 * would otherwise have had to restate them. Resolution happens ONCE and the
 * addresses come back so the caller can dial exactly what was vetted; that is
 * what closes the DNS-rebinding window between the check and the socket.
 */
export const resolveVettedAddresses = async (
  rawHostname: string,
  options?: AssertSafeUrlOptions,
): Promise<string[]> => {
  const hostname = validatePublicHostname(rawHostname)

  if (isIP(hostname) !== 0) {
    return [hostname]
  }

  const resolveHost = options?.resolveHost ?? defaultResolveHost
  let addresses: string[]
  try {
    addresses = await resolveHost(hostname)
  } catch {
    throw new UrlSafetyError('Unable to resolve outbound URL host.')
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => isBlockedIpAddress(address))
  ) {
    throw new UrlSafetyError('Private or local network URLs are not allowed.')
  }
  return addresses
}

// Single source of truth for URLs: validate scheme/credentials, then vet the
// host through the shared resolver above.
const resolveAndValidate = async (
  rawUrl: string | URL,
  options?: AssertSafeUrlOptions,
): Promise<SafeUrlResolution> => {
  const url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError(`Unsupported URL scheme: ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new UrlSafetyError('Authenticated URLs are not allowed.')
  }

  return { addresses: await resolveVettedAddresses(url.hostname, options), url }
}

export const assertSafeUrl = async (
  rawUrl: string | URL,
  options?: AssertSafeUrlOptions,
): Promise<URL> => (await resolveAndValidate(rawUrl, options)).url

// Like assertSafeUrl, but also returns the vetted IPs so the caller can pin the
// socket to them. Pair with createPinnedFetchAgent, or just use safeFetch.
export const assertSafeUrlPinned = resolveAndValidate

// An undici lookup that only ever yields the pre-validated addresses, and
// re-checks each one at connect time. With this as the dispatcher's
// connect.lookup the hostname cannot be re-resolved to a different (rebound,
// internal) address between validation and the socket opening.
const pinnedLookup =
  (addresses: string[]) =>
  (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const vetted = addresses.filter((address) => !isBlockedIpAddress(address))
    const first = vetted[0]
    if (first === undefined) {
      callback(new UrlSafetyError('Private or local network URLs are not allowed.'), '', 0)
      return
    }
    if (options?.all) {
      callback(
        null,
        vetted.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 })),
      )
      return
    }
    callback(null, first, isIP(first) === 6 ? 6 : 4)
  }

/**
 * Undici's own clocks for one dispatcher: `headersTimeout`, the wait for a
 * response's headers, and `bodyTimeout`, the wait between two of its chunks.
 * Absent keeps undici's five-minute defaults; a provider's inference request
 * passes the idle limit (`inferenceDispatcherTimeouts`).
 */
export type DispatcherTimeouts = { bodyTimeout: number; headersTimeout: number }

// An undici dispatcher that connects only to the vetted addresses.
export const createPinnedFetchAgent = (addresses: string[], timeouts?: DispatcherTimeouts): Agent =>
  new Agent({ connect: { lookup: pinnedLookup(addresses) }, ...timeouts })

// A fresh Agent per call would discard the connection pool, costing a TCP+TLS
// handshake on every request — unacceptable on the streaming inference path.
// Agents are keyed by the exact vetted address set, so a reused agent can only
// ever dial addresses that passed the guard for this key; a host that later
// resolves elsewhere produces a different key and therefore a different agent.
const MAX_CACHED_AGENTS = 64
const pinnedAgentCache = new Map<string, Agent>()

const cachedPinnedAgent = (addresses: string[], timeouts?: DispatcherTimeouts): Agent => {
  const key = [...addresses].sort().join(',')
    + (timeouts ? `|${timeouts.headersTimeout}:${timeouts.bodyTimeout}` : '')
  const existing = pinnedAgentCache.get(key)
  if (existing) {
    // Refresh recency so the eviction below drops genuinely cold entries.
    pinnedAgentCache.delete(key)
    pinnedAgentCache.set(key, existing)
    return existing
  }
  const agent = createPinnedFetchAgent(addresses, timeouts)
  pinnedAgentCache.set(key, agent)
  if (pinnedAgentCache.size > MAX_CACHED_AGENTS) {
    const oldestKey = pinnedAgentCache.keys().next().value
    if (oldestKey !== undefined) {
      const evicted = pinnedAgentCache.get(oldestKey)
      pinnedAgentCache.delete(oldestKey)
      void evicted?.close().catch(() => undefined)
    }
  }
  return agent
}

// Node's ambient fetch types name its older dispatcher; use the pinned transport's type here.
type DispatcherRequestInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: Dispatcher }

// The transport safeFetch dials through, already carrying the pinned dispatcher.
// Overridable for the same reason resolveHost is: so the redirect contract can
// be exercised without a live public host.
export type PinnedFetch = (url: URL, init: DispatcherRequestInit) => Promise<Response>

export type SafeFetchOptions =
  AssertSafeUrlOptions & RedirectPolicyOptions & {
    /** The dispatcher's own clocks; undici's defaults when absent (`DispatcherTimeouts`). */
    dispatcherTimeouts?: DispatcherTimeouts
    fetchImpl?: PinnedFetch
  }

const compatibleMultipartBody = (body: RequestInit['body']): UndiciRequestInit['body'] => {
  if (!(body instanceof FormData)) return body as UndiciRequestInit['body']
  // Node's bundled FormData is not recognised by the separately installed
  // Undici transport and would otherwise be sent as "[object FormData]".
  const multipart = new undici.FormData()
  body.forEach((value, name) => {
    if (typeof value === 'string') multipart.append(name, value)
    else multipart.append(name, value, value.name)
  })
  return multipart
}

/**
 * One SSRF-safe request: validate the URL, then pin the socket to exactly the
 * addresses that were validated. Redirects are NOT followed — the raw 3xx comes
 * back so callers that re-validate hops themselves stay in control. Callers that
 * just want a safe request end-to-end should use `safeFetch`.
 */
export const pinnedFetch = async (
  rawUrl: string | URL | Request,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response> => {
  const targetUrl = rawUrl instanceof Request ? rawUrl.url : rawUrl
  const { addresses, url } = await resolveAndValidate(targetUrl, options)
  const fetchImpl: PinnedFetch =
    // The dispatcher and fetch must share Undici's handler protocol. Node's
    // bundled fetch can lag behind our dependency and reject every request.
    options?.fetchImpl ?? ((target, requestInit) =>
      undici.fetch(target, {
        ...requestInit, body: compatibleMultipartBody(requestInit.body),
      } as UndiciRequestInit) as unknown as Promise<Response>)
  const headers = normalizeFetchHeaders(rawUrl, init)
  return fetchImpl(url, {
    ...init,
    headers: [...headers],
    redirect: 'manual',
    dispatcher: cachedPinnedAgent(addresses, options?.dispatcherTimeouts),
  })
}

export type PinnedSocketConnector = (input: {
  address: string
  port: number
}) => Promise<Socket>

export type PinnedConnectOptions = AssertSafeUrlOptions & {
  connectImpl?: PinnedSocketConnector
}

const connectToVettedAddress: PinnedSocketConnector = ({ address, port }) =>
  new Promise((resolvePromise, reject) => {
    // `address` is a literal address returned by resolveAndValidate, never the
    // original hostname, so net.connect cannot open a DNS-rebinding window.
    const socket = connect({ host: address, family: isIP(address), port })
    const onError = (error: Error): void => reject(error)
    socket.once('connect', () => {
      socket.off('error', onError)
      resolvePromise(socket)
    })
    socket.once('error', onError)
  })

/**
 * Open one raw TCP connection to a URL only after URL validation and IP
 * pinning. This is the narrow escape hatch for HTTPS CONNECT-style transports;
 * ordinary HTTP callers must use safeFetch or pinnedFetch instead.
 */
export const pinnedConnect = async (
  rawUrl: string | URL,
  options?: PinnedConnectOptions,
): Promise<{ socket: Socket; url: URL }> => {
  const { addresses, url } = await resolveAndValidate(rawUrl, options)
  if (url.protocol !== 'https:') {
    throw new UrlSafetyError('Pinned raw connections require HTTPS.')
  }
  const address = addresses[0]
  if (!address) throw new UrlSafetyError('Unable to resolve outbound URL host.')
  const port = url.port ? Number(url.port) : 443
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UrlSafetyError('Outbound URL port is invalid.')
  }
  const connectImpl = options?.connectImpl ?? connectToVettedAddress
  return { socket: await connectImpl({ address, port }), url }
}

// SSRF-safe fetch: validates the URL, pins the connection to the validated IPs,
// and re-validates + re-pins on every redirect hop (so a public URL cannot 3xx
// its way to an internal one). Redirects are governed by redirectPolicy:
// 'none' returns the raw 3xx, 'same-origin' (the default for credentialed
// requests) refuses cross-origin hops, and explicit 'follow' strips
// credential-shaped headers on any cross-origin hop and always refuses a
// 307/308 cross-origin body replay. Returns the final Response with its body
// unread.
//
export const safeFetch = async (
  rawUrl: string | URL | Request,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response> => {
  const headers = normalizeFetchHeaders(rawUrl, init)
  const credentialsPresent =
    options?.credentialsPresent === true ||
    [...headers.keys()].some((name) => isCredentialHeaderName(name))
  const policy = resolveRedirectPolicy(options, headers)
  const maxRedirects = options?.maxRedirects ?? 3

  let hopState: {
    body?: RequestInit['body']
    headers: ReadonlyMap<string, string>
    method?: string
    url: URL
  } = {
    body: init?.body,
    headers,
    method: init?.method ?? (rawUrl instanceof Request ? rawUrl.method : undefined),
    url: new URL(rawUrl instanceof Request ? rawUrl.url : rawUrl),
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Resolve here as well as inside pinnedFetch so a relative `location` has
    // the absolute URL of the hop it came from as its base.
    const { url } = await resolveAndValidate(hopState.url, options)
    const hopInit: RequestInit = {
      ...init,
      body: hopState.body,
      headers: [...hopState.headers],
      method: hopState.method,
    }
    const response = await pinnedFetch(url, hopInit, options)
    if (response.status >= 300 && response.status < 400) {
      // Drop the redirect body so its socket returns to the pool.
      const location = response.headers.get('location')
      if (location) await response.body?.cancel().catch(() => undefined)
      const decision = planRedirect({
        body: hopState.body,
        credentialsPresent,
        headers: hopState.headers,
        location,
        method: hopState.method,
        policy,
        status: response.status,
        url: location ? new URL(location, url) : url,
        viaUrl: url,
      })
      if (decision.type === 'follow') {
        hopState = decision.hop
        continue
      }
    }
    return response
  }
  throw new UrlSafetyError('Too many redirects.')
}
