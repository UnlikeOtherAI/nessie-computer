import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { quotaFetch } from './quota-fetch.js'
import { QuotaHttpError, quotaBase, quotaClaims, quotaIso, quotaJson, quotaKey,
  quotaObject as object, quotaRemaining, quotaText, quotaToken } from './quota-values.js'

/** Cursor's reported percentages include bonus usage; spend divided by price does not. */
export const cursorUsageWindows = (value: unknown): ExecutorUsageWindow[] => {
  const body = object(value)
  const usage = object(body.planUsage)
  const end = typeof body.billingCycleEnd === 'number' || typeof body.billingCycleEnd === 'string'
    ? Number(body.billingCycleEnd) : NaN
  const windows = ['totalPercentUsed', 'autoPercentUsed', 'apiPercentUsed'].flatMap(id => {
    const remaining = quotaRemaining(usage[id])
    return remaining === null ? [] : [{ id, kind: 'monthly' as const, remainingPercent: remaining,
      resetsAt: quotaIso(end) }]
  })
  return windows.some(window => window.id === 'autoPercentUsed') && windows.some(window => window.id === 'apiPercentUsed')
    ? windows.filter(window => window.id !== 'totalPercentUsed') : windows
}

export const readCursorQuota = async (env: NodeJS.ProcessEnv, dependencies: {
  fetch?: typeof fetch; now?: () => number
} = {}): Promise<ExecutorSubscription | null> => {
  const key = env.CURSOR_API_KEY?.trim()
  let token = env.CURSOR_AUTH_TOKEN?.trim()
  if (!key && !token) return null
  const base = quotaBase('cursor', (dependencies.now ?? Date.now)())
  base.sourceKey = quotaKey('cursor', 'source', 'configured-cursor-account')
  const fetcher = dependencies.fetch ?? quotaFetch
  // Custom deployments own their credentials and may have a different account API.
  if ((env.CURSOR_API_ENDPOINT && env.CURSOR_API_ENDPOINT.replace(/\/$/u, '') !== 'https://api2.cursor.sh')
    || (env.CURSOR_BACKEND_URL && env.CURSOR_BACKEND_URL.replace(/\/$/u, '') !== 'https://api.cursor.com')) {
    return { ...base, status: 'unsupported' }
  }
  try {
    if ((key?.length ?? 0) > 8192 || (token?.length ?? 0) > 8192) return base
    if (!token && key) {
      const exchange = object(await quotaJson(fetcher, 'https://api2.cursor.sh/auth/exchange_user_api_key', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
      }))
      token = quotaToken(exchange.accessToken) ?? undefined
    }
    if (!token) return base
    const claims = quotaClaims(token)
    const subject = quotaText(claims.sub)
    base.account = quotaText(claims.email)
    base.accountKey = quotaKey('cursor', subject ? 'subject' : 'credential', subject ?? key ?? token)
    if (key) {
      const user = await quotaJson(fetcher, 'https://api.cursor.com/v1/me', {
        headers: { authorization: `Bearer ${key}` },
      }).then(object).catch(() => ({} as Record<string, unknown>))
      base.account = quotaText(user.userEmail) ?? base.account
    }
    const usage = await quotaJson(fetcher,
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          'connect-protocol-version': '1', 'x-cursor-client-type': 'cli' }, body: '{}',
      })
    const windows = cursorUsageWindows(usage)
    return { ...base, windows, status: windows.length ? 'ready' : 'unsupported' }
  } catch (error) {
    return { ...base, status: error instanceof QuotaHttpError && [401, 403].includes(error.status)
      ? 'signed_out' : 'unavailable' }
  }
}
