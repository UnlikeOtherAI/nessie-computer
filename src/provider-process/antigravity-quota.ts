import { readdir } from 'node:fs/promises'
import { arch, homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { readQuotaFile } from './quota-file.js'
import { quotaFetch } from './quota-fetch.js'
import { QuotaHttpError, quotaBase, quotaIso, quotaJson, quotaKey, quotaObject as object, quotaText, quotaToken } from './quota-values.js'
import type { QuotaAccounts } from './quota-values.js'

const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com']
const fractionWindow = (id: string, label: string, quota: Record<string, unknown>,
  kind: ExecutorUsageWindow['kind'], durationMinutes?: number): ExecutorUsageWindow | undefined => {
  const fraction = quota.remainingFraction
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined
  return { id: id.slice(0, 100), label: label.slice(0, 100), kind,
    remainingPercent: Math.max(0, Math.min(1, fraction)) * 100, resetsAt: quotaIso(quota.resetTime),
    ...(durationMinutes ? { durationMinutes } : {}) }
}
/** Reported model buckets share allowances: retain the most restrictive reading for each stable bucket. */
export const mergeAntigravityWindows = (sources: ExecutorUsageWindow[][]): ExecutorUsageWindow[] => {
  const windows = new Map<string, ExecutorUsageWindow>()
  for (const window of sources.flat()) {
    const previous = windows.get(window.id)
    if (!previous || window.remainingPercent < previous.remainingPercent) windows.set(window.id, window)
  }
  return [...windows.values()].slice(0, 16)
}
export const antigravitySummaryWindows = (value: unknown, requestedAt: number): ExecutorUsageWindow[] => {
  const summary = object(value)
  const groups = Array.isArray(summary.groups) && summary.groups.some(raw => Array.isArray(object(raw).buckets))
    ? summary.groups : [{ buckets: summary.buckets }]
  const windows: ExecutorUsageWindow[] = []
  for (const raw of groups.slice(0, 32)) {
    const group = object(raw)
    for (const entry of (Array.isArray(group.buckets) ? group.buckets : []).slice(0, 64)) {
      const bucket = object(entry)
      const id = quotaText(bucket.bucketId, 100)
      if (!id || bucket.disabled === true) continue
      const minutes = bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : undefined
      const label = id.startsWith('gemini-argon-') ? quotaText(group.displayName, 100) ?? 'Gemini Argon'
        : id.startsWith('gemini-') ? 'Gemini' : id.startsWith('3p-') ? 'Claude & GPT'
          : quotaText(group.displayName, 100) ?? quotaText(bucket.displayName, 100) ?? id
      const rollingFull = bucket.remainingFraction === 1 && bucket.description === undefined && minutes
        && Math.abs(Date.parse(String(bucket.resetTime)) - requestedAt - minutes * 60_000) <= 60_000
      const window = fractionWindow(id, label, { ...bucket, ...(rollingFull ? { resetTime: null } : {}) },
        bucket.window === 'weekly' ? 'weekly' : bucket.window === '5h' ? 'session' : 'other', minutes)
      if (window) windows.push(window)
    }
  }
  return mergeAntigravityWindows([windows])
}
export const antigravityModelWindows = (value: unknown): ExecutorUsageWindow[] => {
  const windows: ExecutorUsageWindow[] = []
  for (const [id, raw] of Object.entries(object(object(value).models)).slice(0, 200)) {
    const model = object(raw)
    const family = model.modelProvider === 'MODEL_PROVIDER_GOOGLE' || id.startsWith('gemini-') ? 'Gemini'
      : model.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || id.startsWith('claude-') ? 'Claude'
        : model.modelProvider === 'MODEL_PROVIDER_OPENAI' || id.startsWith('gpt-') ? 'GPT' : null
    if (!family) continue
    for (const [suffix, field] of [['quota', 'quotaInfo'], ['weekly', 'weeklyQuotaInfo']] as const) {
      const window = fractionWindow(`${family.toLowerCase()}-${suffix}`, family, object(model[field]),
        suffix === 'weekly' ? 'weekly' : 'other', suffix === 'weekly' ? 10080 : undefined)
      if (window) windows.push(window)
    }
  }
  return mergeAntigravityWindows([windows])
}

type CachedAccess = { fingerprint: string; access: string; expires: number; accountKey: string; email: string | null }
const cached = new Map<string, CachedAccess>()
const profiles = async (env: NodeJS.ProcessEnv, home: string) => {
  const expand = (path: string) => resolve(path.startsWith('~/') ? join(home, path.slice(2)) : path)
  if (env.ANTIGRAVITY_PROFILE_DIRS?.trim()) {
    const directories = [...new Set(env.ANTIGRAVITY_PROFILE_DIRS.split(',')
      .map(path => path.trim()).filter(Boolean).map(expand))]
    return { directories: directories.slice(0, 16), incomplete: directories.length > 16 }
  }
  const native = expand(env.GEMINI_HOME?.trim() || join(home, '.gemini'))
  const t3 = join(env.T3CODE_HOME?.trim() || join(home, '.t3'), 'userdata/providers/antigravity')
  const entries = await readdir(t3, { withFileTypes: true }).catch(() => [])
  const directories = [native, ...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => join(t3, entry.name)).sort()]
  return { directories: directories.slice(0, 16), incomplete: directories.length > 16 }
}

export const readAntigravityQuotas = async (env: NodeJS.ProcessEnv, dependencies: {
  home?: string; now?: () => number; fetch?: typeof fetch
} = {}): Promise<QuotaAccounts> => {
  if (env.ANTIGRAVITY_AUTH_METHOD && !['oauth-personal', 'oauth-business'].includes(env.ANTIGRAVITY_AUTH_METHOD)) {
    cached.clear()
    return { accounts: [], incomplete: false }
  }
  const { directories, incomplete } = await profiles(env, dependencies.home ?? homedir())
  const current = new Set(directories)
  for (const path of cached.keys()) if (!current.has(path)) cached.delete(path)
  const rawFetch = dependencies.fetch ?? quotaFetch
  const deadline = AbortSignal.timeout(30_000)
  const fetcher: typeof fetch = (input, options = {}) => rawFetch(input, { ...options,
    signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]) })
  const now = dependencies.now ?? Date.now
  const values = await Promise.all(directories.map(async directory => {
    const base = quotaBase('antigravity', now())
    base.sourceKey = quotaKey('antigravity', 'source', directory)
    const text = await readQuotaFile(join(directory, 'antigravity-acp/acp_token.json'), 64 * 1024)
    if (!text) { cached.delete(directory); return null }
    try {
      const token = object(JSON.parse(text))
      const clientId = quotaToken(token.client_id)
      const secret = quotaToken(token.client_secret)
      const refresh = quotaToken(token.refresh_token)
      const project = quotaText(token.project_id, 200)
      if (!clientId || !secret || !refresh) { cached.delete(directory); return { ...base, status: 'signed_out' as const } }
      const fingerprint = quotaKey('antigravity', 'credential', JSON.stringify([clientId, secret, refresh, project]))
      base.accountKey = fingerprint
      let access = cached.get(directory)
      if (!access || access.fingerprint !== fingerprint || access.expires <= now() + 60_000) {
        const previousIdentity = access?.fingerprint === fingerprint ? access : undefined
        cached.delete(directory)
        const response = object(await quotaJson(fetcher, 'https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: secret,
            refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
        }))
        const bearer = quotaToken(response.access_token)
        if (!bearer || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in)
          || response.expires_in <= 0) return base
        const user = await quotaJson(fetcher, 'https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { authorization: `Bearer ${bearer}` },
        }).then(object).catch(() => ({} as Record<string, unknown>))
        const id = quotaText(user.id)
        access = { access: bearer, fingerprint, expires: now() + Math.min(response.expires_in, 3600) * 1000,
          accountKey: id ? quotaKey('antigravity', 'google-account', id) : previousIdentity?.accountKey ?? fingerprint,
          email: quotaText(user.email) ?? previousIdentity?.email ?? null }
        cached.set(directory, access)
      }
      base.accountKey = access.accountKey
      base.account = access.email
      const read = async (operation: string, parse: (value: unknown, at: number) => ExecutorUsageWindow[]) =>
        mergeAntigravityWindows(await Promise.all(ENDPOINTS.map(async endpoint => {
          const requestedAt = now()
          return quotaJson(fetcher, `${endpoint}/v1internal:${operation}`, {
            method: 'POST', headers: { authorization: `Bearer ${access.access}`, 'content-type': 'application/json',
              'user-agent': `antigravity/hub/2.24.0 (aidev_client; os_type=${platform()}; arch=${arch()}; cl=963137146)` },
            body: JSON.stringify(project ? { project } : {}),
          }).then(value => parse(value, requestedAt)).catch(error => {
            if (error instanceof QuotaHttpError && error.status === 401) access.expires = 0
            return []
          })
        })))
      const summary = await read('retrieveUserQuotaSummary', antigravitySummaryWindows)
      const windows = summary.length ? summary : await read('fetchAvailableModels', antigravityModelWindows)
      return { ...base, windows, status: windows.length ? 'ready' as const : 'unavailable' as const }
    } catch (error) {
      cached.delete(directory)
      return { ...base, status: error instanceof QuotaHttpError && [400, 401].includes(error.status)
        ? 'signed_out' as const : 'unavailable' as const }
    }
  }))
  return { accounts: values.filter((value): value is ExecutorSubscription => value !== null), incomplete }
}
