import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { readQuotaFile } from './quota-file.js'
import { quotaFetch } from './quota-fetch.js'
import { QuotaHttpError, quotaBase, quotaClaims, quotaIso, quotaJson, quotaKey,
  quotaObject as object, quotaRemaining, quotaText, quotaToken } from './quota-values.js'

const boundary = (value: unknown): number => {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return NaN
  const date = value.slice(0, 10)
  const midnight = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return NaN
  return Date.parse(value)
}
export const grokBuildUsageWindows = (value: unknown): ExecutorUsageWindow[] => {
  const config = object(object(value).config)
  const period = object(config.currentPeriod)
  const type = typeof period.type === 'string' ? period.type.replace(/^USAGE_PERIOD_TYPE_/u, '') : ''
  const kind = type === 'WEEKLY' ? 'weekly' : type === 'MONTHLY' ? 'monthly' : 'other'
  let used = config.creditUsagePercent
  // The native endpoint omits zero only when it still supplies a complete subscription period.
  if (used === undefined && kind !== 'other' && boundary(period.start) < boundary(period.end)) used = 0
  const remaining = quotaRemaining(used)
  return remaining === null ? [] : [{ id: 'subscription', kind,
    remainingPercent: remaining, resetsAt: quotaIso(period.end) }]
}
const CUSTOM_AUTH = ['XAI_API_KEY', 'GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OAUTH2_ISSUER',
  'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_PRINCIPAL_TYPE', 'GROK_OAUTH2_PRINCIPAL_ID', 'GROK_AUTH_PROVIDER_COMMAND',
  'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_MODELS_BASE_URL', 'GROK_CONFIG', 'GROK_CONFIG_PATH']

export const readGrokBuildQuota = async (env: NodeJS.ProcessEnv, dependencies: {
  home?: string; fetch?: typeof fetch; now?: () => number
} = {}): Promise<ExecutorSubscription | null> => {
  if (CUSTOM_AUTH.some(name => env[name]?.trim())) return null
  const directory = env.GROK_HOME?.trim() || join(dependencies.home ?? homedir(), '.grok')
  for (const path of [join(directory, 'config.toml'), join(directory, 'managed_config.toml'),
    join(directory, 'requirements.toml'), '/etc/grok/managed_config.toml', '/etc/grok/requirements.toml']) {
    const config = await readQuotaFile(path, 64 * 1024, true)
    if (config && /^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/mu.test(config)) return null
  }
  let credential: Record<string, unknown>
  try {
    const text = env.GROK_AUTH?.trim() || await readQuotaFile(join(directory, 'auth.json'), 64 * 1024)
    const stored = object(JSON.parse(text || '{}'))
    credential = object(stored['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828']
      ?? stored['https://accounts.x.ai/sign-in'])
  } catch { return null }
  const token = quotaToken(credential.key)
  if (!token || credential.auth_mode === 'api_key') return null
  const base = quotaBase('grok_build', (dependencies.now ?? Date.now)())
  base.sourceKey = quotaKey('grok_build', 'source', directory)
  base.account = quotaText(credential.email)
  const subject = quotaText(quotaClaims(token).sub)
  base.accountKey = quotaKey('grok_build', subject ? 'subject' : 'credential', subject ?? token)
  try {
    const usage = await quotaJson(dependencies.fetch ?? quotaFetch,
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers: { authorization: `Bearer ${token}` } })
    const windows = grokBuildUsageWindows(usage)
    return { ...base, windows, status: windows.length ? 'ready' : 'unsupported' }
  } catch (error) {
    return { ...base, status: error instanceof QuotaHttpError && error.status === 401 ? 'signed_out' : 'unavailable' }
  }
}
