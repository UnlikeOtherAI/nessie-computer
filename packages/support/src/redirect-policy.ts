// Redirect policy for the SSRF-safe transports in `url-safety.ts`.
//
// Sensitivity is typed, never inferred: callers that attach a credential mark
// the request `credentialsPresent` (Sol SB-05 — an MCP API-key auth header can
// have any caller-chosen name, so a name list can never fully classify it).
// The credential-shaped name list below is defense in depth for callers that
// pass the standard names without the flag. Normalization at entry covers all
// RequestInit.headers shapes plus `Request` input (design review 1.2) so the list
// applies no matter how the headers were spelled.
//
// This module owns UrlSafetyError so it can throw refusal errors without a
// circular import; url-safety.ts re-exports it unchanged.

export class UrlSafetyError extends Error {
  override readonly name = 'UrlSafetyError'
}

export type RedirectPolicy = 'follow' | 'same-origin' | 'none'

export type RedirectPolicyOptions = {
  redirectPolicy?: RedirectPolicy
  credentialsPresent?: boolean
  maxRedirects?: number
}

// Credential-shaped header names recognized as sensitivity markers under
// explicit `credentialsPresent: true` (which covers the arbitrary-name cases
// this list cannot see).
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-nessie-context',
  'x-uoa-delegation',
])

export const isCredentialHeaderName = (name: string): boolean =>
  CREDENTIAL_HEADER_NAMES.has(name)

// One canonical lowercase map from every RequestInit.headers shape — a Headers
// instance, [name, value] pairs, or a plain record — plus a Request object
// passed as the input argument, whose headers merge UNDER explicit init
// headers exactly as fetch( input, init ) applies them.
export const normalizeFetchHeaders = (
  input?: unknown,
  init?: RequestInit,
): Map<string, string> => {
  const headers = new Map<string, string>()
  const merge = (raw: RequestInit['headers']): void => {
    if (!raw) return
    if (raw instanceof Headers) {
      raw.forEach((value, key) => headers.set(key.toLowerCase(), value))
      return
    }
    if (Array.isArray(raw)) {
      for (const pair of raw as ReadonlyArray<ReadonlyArray<string>>) {
        const name = pair[0]
        const value = pair[1]
        if (name !== undefined && value !== undefined) {
          headers.set(name.toLowerCase(), value)
        }
      }
      return
    }
    for (const [name, value] of Object.entries(raw)) {
      if (typeof value === 'string') headers.set(name.toLowerCase(), value)
    }
  }
  if (input instanceof Request) merge(input.headers)
  merge(init?.headers)
  return headers
}

// Default resolution: an explicit option always wins; otherwise a request that
// carries credentials (flagged or credential-shaped header) defaults to
// 'same-origin'; anything else keeps the historic uncredentialed behaviour of
// following redirects. maxRedirects: 0 remains supported and is equivalent to
// 'none'.
export const resolveRedirectPolicy = (
  options: RedirectPolicyOptions | undefined,
  headers: ReadonlyMap<string, string>,
): RedirectPolicy => {
  if (options?.redirectPolicy) return options.redirectPolicy
  if (options?.maxRedirects === 0) return 'none'
  const credentialed =
    options?.credentialsPresent === true ||
    [...headers.keys()].some((name) => isCredentialHeaderName(name))
  return credentialed ? 'same-origin' : 'follow'
}

export type RedirectHop = {
  body?: RequestInit['body']
  headers: Map<string, string>
  method?: string
  url: URL
}

// The outcome of inspecting one 3xx response. 'none' and the no-location case
// hand the response back untouched; 'same-origin'/'follow' either plan the
// next hop or refuse.
export type RedirectDecision =
  | { type: 'follow'; hop: RedirectHop }
  | { type: 'return' }

// Decide what a redirect response means for the current request. `url` is the
// already-resolved absolute hop target. `location` is null when the 3xx
// carries no usable Location header. Refusals throw UrlSafetyError.
export const planRedirect = (input: {
  body?: RequestInit['body']
  credentialsPresent: boolean
  headers: ReadonlyMap<string, string>
  location: string | null
  method?: string
  policy: RedirectPolicy
  status: number
  url: URL
  viaUrl: URL
}): RedirectDecision => {
  const { location, policy, status, url, viaUrl } = input
  if (!location) return { type: 'return' }
  if (policy === 'none') return { type: 'return' }

  const method = input.method?.toUpperCase() ?? 'GET'
  const bodyPresent = input.body !== undefined && input.body !== null
  const crossOrigin = url.origin !== viaUrl.origin

  if (crossOrigin && policy === 'same-origin') {
    throw new UrlSafetyError(
      `Refusing cross-origin redirect from ${viaUrl.origin} to ${url.origin} under the 'same-origin' redirect policy.`,
    )
  }
  // A 307/308 preserves method and body; replaying the body to a different
  // origin is refused outright, never "rewritten" (spec: 303 alone converts to
  // GET and drops the body).
  if (crossOrigin && bodyPresent && (status === 307 || status === 308)) {
    throw new UrlSafetyError(
      `Refusing ${status} redirect from ${viaUrl.origin} to ${url.origin}: the request body would be replayed to a different origin.`,
    )
  }

  const hop: RedirectHop = { headers: new Map(input.headers), url }
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    hop.method = 'GET'
    hop.body = undefined
    hop.headers.delete('content-type')
    hop.headers.delete('content-length')
  } else {
    hop.method = method
    hop.body = input.body
  }
  if (crossOrigin) {
    // Under an explicit 'follow' the hop is allowed, but credential-shaped
    // headers never cross an origin boundary. A credential under a
    // caller-chosen name cannot be spotted here — that is exactly why
    // credential-attaching code must carry `credentialsPresent` (typed
    // sensitivity) and why OAuth-class flows pin `redirectPolicy: 'none'`
    // rather than relying on stripping (Sol SB-05).
    for (const name of [...hop.headers.keys()]) {
      if (isCredentialHeaderName(name)) hop.headers.delete(name)
    }
  }
  return { type: 'follow', hop }
}
