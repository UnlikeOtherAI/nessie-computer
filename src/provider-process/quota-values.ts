import { createHash } from 'node:crypto'
import type { ExecutorSubscription } from '@nessie/executor-protocol'

export const quotaObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const quotaText = (value: unknown, limit = 254): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null
export const quotaToken = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && value.trim().length <= 8192 ? value.trim() : null
export const quotaRemaining = (used: unknown): number | null =>
  typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : null
export const quotaIso = (value: unknown): string | null => {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null
    const date = value.slice(0, 10)
    const midnight = Date.parse(`${date}T00:00:00Z`)
    if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return null
  }
  const at = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? new Date(at).toISOString() : null
}
/** Display grouping only; unverified claims never authenticate a person or grant product access. */
export const quotaClaims = (token: string): Record<string, unknown> => {
  try { return quotaObject(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))) }
  catch { return {} }
}
export const quotaKey = (provider: string, kind: string, value: string): string =>
  createHash('sha256').update(JSON.stringify([provider, kind, value])).digest('hex')
export const quotaBase = (provider: ExecutorSubscription['provider'], now: number,
  source: ExecutorSubscription['source'] = 'provider_api'): ExecutorSubscription => ({
  provider, source, account: null, plan: null, windows: [], status: 'unavailable',
  checkedAt: new Date(now).toISOString(),
})
export type QuotaAccounts = { accounts: ExecutorSubscription[]; incomplete: boolean }
export class QuotaHttpError extends Error {
  constructor(readonly status: number) { super(`Quota request failed (${status}).`) }
}
export const quotaJson = async (fetcher: typeof fetch, url: string, options: RequestInit = {}): Promise<unknown> => {
  const response = await fetcher(url, { ...options, redirect: 'error' })
  if (!response.ok) throw new QuotaHttpError(response.status)
  return response.json()
}
