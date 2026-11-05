const DEFAULT_MAX_CONCURRENT_TUNNELS = 4
const MAX_CONCURRENT_TUNNELS = 16

export class ExecutorEgressPolicyError extends Error {
  override readonly name = 'ExecutorEgressPolicyError'
}

export type ExecutorEgressPolicy = {
  allowedOrigins: string[]
  maxConcurrentTunnels?: number
}

export type ExecutorEgressSettings = {
  allowedOrigins: Set<string>
  maxConcurrentTunnels: number
}

const configuredOrigin = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ExecutorEgressPolicyError('An allowed browser origin is malformed.')
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.port
  ) {
    throw new ExecutorEgressPolicyError('An allowed browser origin must be an HTTPS origin without a path or port.')
  }
  return url.origin
}

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new ExecutorEgressPolicyError(`${label} is outside its permitted range.`)
  }
  return selected
}

/**
 * The daemon's browser gateway is deny-by-default. Its local policy names
 * whole HTTPS origins—not path patterns, wildcard domains, LAN addresses, or
 * a catch-all proxy mode. Every browser request is rechecked against this
 * set before the gateway opens a pinned socket.
 */
export const compileExecutorEgressPolicy = (
  policy: ExecutorEgressPolicy,
): ExecutorEgressSettings => {
  const origins = policy.allowedOrigins.map(configuredOrigin)
  const uniqueOrigins = new Set(origins)
  if (uniqueOrigins.size === 0 || uniqueOrigins.size !== origins.length) {
    throw new ExecutorEgressPolicyError('Specify one or more distinct allowed browser origins.')
  }
  return {
    allowedOrigins: uniqueOrigins,
    maxConcurrentTunnels: boundedInteger(
      policy.maxConcurrentTunnels,
      DEFAULT_MAX_CONCURRENT_TUNNELS,
      MAX_CONCURRENT_TUNNELS,
      'The browser tunnel limit',
    ),
  }
}

/**
 * Check only the local policy ceiling. The gateway invokes pinnedConnect once
 * afterwards, so hostname resolution and socket pinning happen together rather
 * than validating a hostname and resolving it again before the dial.
 */
export const assertExecutorEgressOrigin = (
  rawUrl: string | URL,
  settings: ExecutorEgressSettings,
): void => {
  let url: URL
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl
  } catch {
    throw new ExecutorEgressPolicyError('The browser target is malformed.')
  }
  if (url.protocol !== 'https:' || url.username || url.password || !settings.allowedOrigins.has(url.origin)) {
    throw new ExecutorEgressPolicyError('The browser target is not allowed by local policy.')
  }
}
