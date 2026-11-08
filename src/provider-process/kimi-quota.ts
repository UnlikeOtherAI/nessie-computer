import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { quotaFetch } from './quota-fetch.js'
import { readQuotaFile } from './quota-file.js'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const reset = (value: unknown): string | null => {
  const number = numeric(value)
  const epoch = number === null ? typeof value === 'string' ? Date.parse(value) : NaN
    : number > 1e12 ? number : number * 1000
  return Number.isFinite(epoch) && epoch > 0 && epoch < 8.64e15 ? new Date(epoch).toISOString() : null
}
const left = (value: unknown): number | null => {
  const item = record(value)
  const limit = numeric(item.limit)
  if (limit === null || limit <= 0) return null
  const used = numeric(item.used)
  const remaining = numeric(item.remaining)
  if (used !== null && used >= 0) return Math.max(0, 100 - used / limit * 100)
  return remaining !== null && remaining >= 0 && remaining <= limit ? remaining / limit * 100 : null
}

/** Mirrors SysMon's native Kimi usage/limits shapes. Missing or malformed values never mean zero usage. */
export const kimiUsageWindows = (value: unknown): ExecutorUsageWindow[] => {
  const root = record(value)
  const windows: ExecutorUsageWindow[] = []
  const weekly = record(root.usage)
  const weeklyLeft = left(weekly)
  if (weeklyLeft !== null) windows.push({ id: 'kimi:weekly', kind: 'weekly', durationMinutes: 10080,
    remainingPercent: weeklyLeft, resetsAt: reset(weekly.resetTime) })
  const unitMinutes: Record<string, number> = {
    TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440,
    MINUTE: 1, HOUR: 60, DAY: 1440, minute: 1, hour: 60, day: 1440,
  }
  for (const raw of Array.isArray(root.limits) ? root.limits : []) {
    const limit = record(raw)
    const detail = record(limit.detail ?? limit)
    const remaining = left(detail)
    if (remaining === null) continue
    const window = record(limit.window)
    const duration = numeric(window.duration)
    const minutes = duration !== null && duration > 0 && typeof window.timeUnit === 'string'
      ? duration * (unitMinutes[window.timeUnit] ?? 0) : 0
    const name = typeof limit.name === 'string' ? limit.name.slice(0, 80) : null
    windows.push({ id: minutes > 0 ? `kimi:${minutes}m` : name || `kimi:limit-${windows.length}`,
      kind: minutes >= 10080 ? 'weekly' : minutes > 0 ? 'session' : 'other',
      ...(minutes > 0 ? { durationMinutes: minutes } : {}), remainingPercent: remaining,
      resetsAt: reset(detail.resetTime ?? detail.resetAt ?? detail.reset_at) })
  }
  for (const [id, minutes] of [['limit_5h', 300], ['limit_7d', 10080]] as const) {
    const usage = record(record(root.usages)[id])
    const ratio = numeric(usage.used_ratio)
    if (ratio === null || ratio < 0 || ratio > 1) continue
    if (id === 'limit_7d' && weeklyLeft !== null) continue
    const key = `kimi:${minutes}m`
    const existing = windows.find(window => window.id === key)
    const remaining = 100 * (1 - ratio)
    if (existing) {
      if (remaining < existing.remainingPercent) {
        existing.remainingPercent = remaining
        existing.resetsAt = reset(usage.reset_time)
      }
    } else windows.push({ id: key, kind: minutes === 10080 ? 'weekly' : 'session', durationMinutes: minutes,
      remainingPercent: remaining, resetsAt: reset(usage.reset_time) })
  }
  return windows.slice(0, 16)
}

const credential = async (env: NodeJS.ProcessEnv, home: string, now: number) => {
  let expired = false
  for (const directory of ['.kimi-code', '.kimi']) {
    try {
      const text = await readQuotaFile(join(home, directory, 'credentials/kimi-code.json'), 64 * 1024)
      if (!text) continue
      const value = record(JSON.parse(text))
      if (typeof value.access_token !== 'string' || !value.access_token.trim()) continue
      const expires = numeric(value.expires_at)
      if (expires !== null && expires * 1000 <= now) { expired = true; continue }
      return { token: value.access_token.trim(), expired: false }
    } catch { /* The CLI owns refresh and sign-in; Nessie never rotates its credentials. */ }
  }
  const key = env.KIMI_API_KEY?.trim() ?? (await readQuotaFile(join(home, '.kimix/token'), 8192))?.trim()
  if (key) return { token: key, expired: false }
  for (const directory of ['.kimi-code', '.kimi']) {
    const config = await readQuotaFile(join(home, directory, 'config.toml'), 64 * 1024)
    for (const block of config?.split(/(?=^\[)/mu) ?? []) {
      if (!/^\[providers\.[^\]]+\]/u.test(block)
        || !/^\s*base_url\s*=\s*["']https:\/\/api\.kimi\.com\/coding\/v1\/?["']/mu.test(block)) continue
      const match = /^\s*api_key\s*=\s*["']([^"'\r\n]+)["']/mu.exec(block)
      if (match) return { token: match[1]!, expired: false }
    }
  }
  return { token: undefined, expired }
}

export const readKimiQuota = async (env: NodeJS.ProcessEnv, dependencies: {
  home?: string; now?: () => number; fetch?: typeof fetch
} = {}): Promise<ExecutorSubscription | null> => {
  const now = (dependencies.now ?? Date.now)()
  const found = await credential(env, dependencies.home ?? homedir(), now)
  const base: ExecutorSubscription = { provider: 'kimi', source: 'kimi_api', checkedAt: new Date(now).toISOString(),
    account: null, plan: null, windows: [], status: 'unavailable' }
  if (!found.token) return found.expired ? { ...base, status: 'signed_out' } : null
  if (found.token.length > 8192) return base
  // Claims/fingerprints group displayed readings only. They grant no product access or provider authority.
  let subject: string | undefined
  try {
    const claims = record(JSON.parse(Buffer.from(found.token.split('.')[1] ?? '', 'base64url').toString('utf8')))
    if (typeof claims.email === 'string') base.account = claims.email.slice(0, 254)
    if (typeof claims.sub === 'string' && claims.sub.trim()) subject = claims.sub.trim()
  } catch { /* Opaque API keys need not be JWTs. */ }
  base.accountKey = createHash('sha256').update(JSON.stringify(['kimi', subject ? 'subject' : 'credential',
    subject ?? found.token])).digest('hex')
  try {
    const response = await (dependencies.fetch ?? quotaFetch)('https://api.kimi.com/coding/v1/usages', {
      method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${found.token}` },
    })
    if (response.status === 401 || response.status === 403) return { ...base, status: 'signed_out' }
    if (!response.ok) return base
    const windows = kimiUsageWindows(await response.json())
    return { ...base, windows, status: windows.length ? 'ready' : 'unavailable' }
  } catch { return base }
}
