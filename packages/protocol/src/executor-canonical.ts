/**
 * Canonical JSON shared by every executor trust boundary. The executor grammar
 * accepts finite JSON values only, which lets us avoid a lossy stringifier
 * while retaining a small, auditable RFC 8785-compatible subset.
 */
export const canonicalExecutorJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalExecutorJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalExecutorJson(record[key])}`
    )).join(',')}}`
  }
  throw new TypeError('Cannot canonicalize unsupported value')
}

export const canonicalExecutorPayload = (
  domain: string,
  value: unknown,
): string => `${domain}\n${canonicalExecutorJson(value)}`
