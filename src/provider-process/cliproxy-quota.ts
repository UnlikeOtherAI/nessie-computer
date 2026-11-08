import { safeFetch } from '@nessie/executor-support/url-safety'
import { fetch as loopbackFetch, type RequestInit as LoopbackInit } from 'undici'
import type { ExecutorSubscription } from '@nessie/executor-protocol'
import { readQuotaFile } from './quota-file.js'
import { boundQuotaResponse } from './quota-fetch.js'
import { claudeSubscription, codexSubscription } from './cli-quota-projection.js'
import { QuotaHttpError, quotaIso, quotaJson, quotaKey, quotaObject as object, quotaText, quotaToken } from './quota-values.js'
import type { QuotaAccounts } from './quota-values.js'

const BASE = 'https://chatgpt.com/backend-api/wham'
type Hub = { url: URL; key: string; id: string }
const retained = new Map<string, QuotaAccounts & { at: number }>()
const hubs = async (env: NodeJS.ProcessEnv): Promise<{ hubs: Hub[]; incomplete: boolean }> => {
  let sources: unknown = []
  if (env.NESSIE_CLIPROXY_SOURCES_FILE) {
    const text = await readQuotaFile(env.NESSIE_CLIPROXY_SOURCES_FILE, 64 * 1024)
    try { sources = JSON.parse(text || 'null') } catch { return { hubs: [], incomplete: true } }
  } else if (env.NESSIE_CLIPROXY_URL && env.NESSIE_CLIPROXY_MANAGEMENT_KEY) sources = [{
    url: env.NESSIE_CLIPROXY_URL, managementKey: env.NESSIE_CLIPROXY_MANAGEMENT_KEY,
  }]
  else if (env.NESSIE_CLIPROXY_URL || env.NESSIE_CLIPROXY_MANAGEMENT_KEY) return { hubs: [], incomplete: true }
  if (!Array.isArray(sources)) return { hubs: [], incomplete: true }
  const selected = sources.filter(source => object(source).enabled !== false)
  const values = selected.slice(0, 8).flatMap(raw => {
    const source = object(raw)
    const key = quotaToken(source.managementKey)
    try {
      const url = new URL(String(source.url))
      if (!key || url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) return []
      url.pathname = url.pathname.replace(/(\/management\.html)?\/?$/iu, '/')
      return [{ url, key, id: quotaKey('cliproxy', 'source', JSON.stringify([url.href, key])) }]
    } catch { return [] }
  })
  return { hubs: values, incomplete: selected.length > 8 || values.length !== selected.length }
}

export const readCliProxyQuotas = async (env: NodeJS.ProcessEnv, dependencies: {
  fetch?: typeof fetch; now?: () => number
} = {}): Promise<QuotaAccounts> => {
  const discovery = await hubs(env)
  const configured = discovery.hubs
  for (const id of retained.keys()) if (!configured.some(hub => hub.id === id)) retained.delete(id)
  const now = (dependencies.now ?? Date.now)()
  const readHub = async (hub: Hub) => {
    const deadline = AbortSignal.timeout(30_000)
    const checkedAt = new Date(now).toISOString()
    const transport: typeof fetch = dependencies.fetch ?? (async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.origin !== hub.url.origin || !url.pathname.startsWith(`${hub.url.pathname}v0/management/`)) {
        throw new Error('CLIProxyAPI management endpoint is not supported.')
      }
      const request = { ...options, redirect: 'error' as const,
        signal: AbortSignal.any([deadline, AbortSignal.timeout(8_000)]) }
      const response = url.hostname === '127.0.0.1'
        ? await loopbackFetch(url, request as LoopbackInit) as unknown as Response
        : await safeFetch(url, request, { credentialsPresent: true, maxRedirects: 0 })
      return boundQuotaResponse(response)
    })
    const fetcher: typeof fetch = (input, options = {}) => transport(input, { ...options, signal: deadline })
    const management = (path: string, body?: unknown) => quotaJson(fetcher,
      new URL(`v0/management/${path}`, hub.url).href, {
        method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${hub.key}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    try {
      const listing = object(await management('auth-files'))
      if (!Array.isArray(listing.files)) throw new Error('Invalid CLIProxyAPI account list.')
      const selected = listing.files.slice(0, 128).map(object).filter(file => file.disabled !== true
        && ['claude', 'codex'].includes(String(file.provider)))
      const files = selected.filter(file => quotaText(file.auth_index) && quotaText(file.id))
      const accounts: ExecutorSubscription[] = []
      // Limit concurrency and total accounts; the snapshot marks a truncated collection explicitly.
      for (let index = 0; index < files.length; index += 4) {
        accounts.push(...await Promise.all(files.slice(index, index + 4).map(async file => {
          const codex = file.provider === 'codex'
          const token = object(file.id_token)
          const account = quotaText(file.email)
          const call = async (url: string): Promise<Record<string, unknown>> => {
            const result = object(await management('api-call', { auth_index: file.auth_index, method: 'GET', url,
              header: codex ? { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json',
                'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop',
                ...(quotaText(token.chatgpt_account_id) ? { 'Chatgpt-Account-Id': token.chatgpt_account_id } : {}) }
                : { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20',
                  'User-Agent': 'claude-code/2.1.273' } }))
            if (typeof result.status_code !== 'number' || result.status_code < 200 || result.status_code >= 300) {
              throw new QuotaHttpError(typeof result.status_code === 'number' ? result.status_code : 502)
            }
            return object(JSON.parse(typeof result.body === 'string' ? result.body : 'null'))
          }
          const read = (usage: Record<string, unknown>): ExecutorSubscription => {
            if (!codex) return claudeSubscription({ account: { email: account } }, { rate_limits_available: true,
              rate_limits: { ...usage, model_scoped: (Array.isArray(usage.limits) ? usage.limits : []).map(object)
                .filter(limit => limit.kind === 'weekly_scoped').map(limit => ({
                  display_name: object(object(limit.scope).model).display_name,
                  utilization: limit.percent, resets_at: limit.resets_at,
                })) } }, checkedAt)
            const window = (raw: unknown) => {
              const value = object(raw)
              return { usedPercent: value.used_percent, resetsAt: value.reset_at,
                ...(typeof value.limit_window_seconds === 'number'
                  ? { windowDurationMins: value.limit_window_seconds / 60 } : {}) }
            }
            const limits = object(usage.rate_limit)
            const plan = usage.plan_type ?? token.plan_type ?? token.chatgpt_plan_type
            const rateLimits = { primary: window(limits.primary_window), secondary: window(limits.secondary_window) }
            return codexSubscription({ account: { email: account, planType: plan } },
              { accountId: token.chatgpt_account_id, rateLimits }, checkedAt)
          }
          let result = read({})
          try { result = read(await call(codex ? `${BASE}/usage` : 'https://api.anthropic.com/api/oauth/usage')) }
          catch (error) {
            result.status = error instanceof QuotaHttpError && error.status === 401 ? 'signed_out' : 'unavailable'
          }
          if (codex && result.status === 'ready') {
            const credits = await call(`${BASE}/rate-limit-reset-credits`).then(value =>
              (Array.isArray(value.credits) ? value.credits : []).map(object).filter(credit =>
                credit.reset_type === 'codex_rate_limits' && credit.status === 'available'
                  && quotaIso(credit.expires_at) && Date.parse(String(credit.expires_at)) > now)).catch(() => undefined)
            if (credits) {
              const expiry = credits.map(credit => String(credit.expires_at)).sort()[0]
              result.resetCredits = { availableCount: credits.length, ...(expiry ? { nextExpiresAt: expiry } : {}) }
            }
          }
          return { ...result, source: 'cliproxy' as const,
            sourceKey: quotaKey('cliproxy', 'account', `${hub.id}:${String(file.id)}`),
            ...(result.accountKey ? {} : { accountKey: quotaKey(String(file.provider), 'hub-account', `${hub.id}:${String(file.id)}`) }) }
        })))
      }
      const incomplete = listing.files.length > 128 || files.length !== selected.length
      retained.set(hub.id, { at: now, accounts, incomplete })
      return { accounts, incomplete }
    } catch (error) {
      const previous = retained.get(hub.id)
      if (!previous || now - previous.at > 15 * 60_000) return { accounts: [], incomplete: true }
      return { incomplete: true, accounts: previous.accounts.map(account => ({ ...account,
        status: error instanceof QuotaHttpError && [401, 403].includes(error.status) ? 'signed_out' as const : 'unavailable' as const,
        ...(error instanceof QuotaHttpError && [401, 403].includes(error.status)
          ? { windows: [], resetCredits: undefined } : {}),
      })) }
    }
  }
  const sources = await Promise.all(configured.map(readHub))
  return { accounts: sources.flatMap(source => source.accounts),
    incomplete: discovery.incomplete || sources.some(source => source.incomplete) }
}
