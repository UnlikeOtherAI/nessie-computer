import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { providerAccountIdentity } from '../provider-account-identity.js'
import { codexResetCredits } from './reset-credit-quota.js'
import { quotaIso } from './quota-values.js'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, limit: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null
const remaining = (used: unknown): number | null =>
  typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : null
const time = (value: unknown): string | null => quotaIso(typeof value === 'number' ? value * 1000 : value)
const base = (provider: ExecutorSubscription['provider'], checkedAt: string): ExecutorSubscription => ({
  provider, checkedAt, status: 'unavailable', account: null, plan: null, windows: [],
})

/**
 * The app-server's account and rate-limit responses, projected independently.
 * `signedIn` is what `codex login status` said, when the caller asked it: then
 * an `account: null` answer means only that the account has no name here.
 */
export const codexSubscription = (
  accountValue: unknown, limitsValue: unknown, checkedAt: string, login: { signedIn?: boolean } = {},
): ExecutorSubscription => {
  const root = object(accountValue)
  const account = object(root.account)
  if (root.account === null && login.signedIn !== true) return { ...base('codex', checkedAt), status: 'signed_out' }
  const limits = object(limitsValue)
  const buckets = object(limits.rateLimitsByLimitId)
  const main = object(buckets.codex ?? limits.rateLimits)
  const plan = text(main.planType ?? account.planType, 100)
  const windows: ExecutorUsageWindow[] = []
  const snapshots = [['codex', main], ...Object.entries(buckets).filter(([id]) => id !== 'codex')] as const
  for (const [bucketId, raw] of snapshots) {
    const snapshot = object(raw)
    for (const name of ['primary', 'secondary'] as const) {
      const window = object(snapshot[name])
      const left = remaining(window.usedPercent)
      if (left === null) continue
      const duration = typeof window.windowDurationMins === 'number'
        && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0
        ? window.windowDurationMins : null
      const kind = bucketId !== 'codex' ? 'other' : duration !== null
        ? duration >= 30 * 24 * 60 ? 'monthly' : duration >= 7 * 24 * 60 ? 'weekly' : 'session'
        : name === 'secondary' ? 'weekly' : plan === 'free' || plan === 'go' ? 'monthly' : 'session'
      windows.push({ id: `${bucketId}:${name}`.slice(0, 100), kind, remainingPercent: left,
        ...(bucketId !== 'codex' ? { label: bucketId.slice(0, 100) } : {}),
        resetsAt: time(window.resetsAt), ...(duration ? { durationMinutes: duration } : {}) })
    }
    const individual = object(snapshot.individualLimit)
    const left = individual.remainingPercent
    if (typeof left === 'number' && Number.isFinite(left) && left >= 0 && left <= 100) {
      windows.push({ id: `${bucketId}:individual`.slice(0, 100), kind: 'monthly',
        remainingPercent: left, resetsAt: time(individual.resetsAt) })
    }
  }
  const email = text(account.email, 254)
  const resetCredits = codexResetCredits(limits.rateLimitResetCredits)
  return { ...base('codex', checkedAt), account: email, plan,
    ...(resetCredits ? { resetCredits } : {}),
    ...providerAccountIdentity('codex', email, limits.accountId),
    status: windows.length ? 'ready' : account.type === 'apiKey' ? 'unsupported' : 'unavailable',
    windows: windows.slice(0, 16) }
}

export const claudeSubscription = (
  initValue: unknown, usageValue: unknown, checkedAt: string, organization?: string,
): ExecutorSubscription => {
  const account = object(object(initValue).account)
  const usage = object(usageValue)
  const limits = object(usage.rate_limits)
  const windows: ExecutorUsageWindow[] = []
  for (const [id, kind, durationMinutes] of [['five_hour', 'session', 300], ['seven_day', 'weekly', 10080]] as const) {
    const window = object(limits[id])
    const left = remaining(window.utilization)
    if (left !== null) windows.push({ id, kind, durationMinutes, remainingPercent: left,
      resetsAt: time(window.resets_at) })
  }
  const scoped = limits.model_scoped
  if (Array.isArray(scoped)) for (const raw of scoped) {
    const window = object(raw)
    const left = remaining(window.utilization)
    const id = text(window.display_name, 80)
    if (id && left !== null) windows.push({ id: `model:${id}`, kind: 'other', label: id,
      remainingPercent: left, resetsAt: time(window.resets_at) })
  }
  const extra = object(limits.extra_usage)
  const spend = object(limits.spend)
  const spent = object(spend.used)
  const budget = object(spend.limit)
  const spendRatio = spend.enabled === true && typeof spent.amount_minor === 'number'
    && Number.isFinite(spent.amount_minor) && spent.amount_minor >= 0
    && typeof budget.amount_minor === 'number' && budget.amount_minor > 0
    && Number.isFinite(budget.amount_minor) && typeof spent.exponent === 'number'
    && Number.isInteger(spent.exponent) && spent.exponent >= 0
    && typeof spent.currency === 'string' && spent.currency.trim().length > 0
    && spent.currency === budget.currency && spent.exponent === budget.exponent
    ? spent.amount_minor / budget.amount_minor * 100 : null
  const used = typeof extra.used_credits === 'number' && typeof extra.monthly_limit === 'number'
    && extra.monthly_limit > 0 ? extra.used_credits / extra.monthly_limit * 100 : extra.utilization
  const spendLeft = remaining(spendRatio ?? used)
  if ((extra.is_enabled === true || spendRatio !== null) && spendLeft !== null) windows.push({
    id: 'monthly_spend', kind: 'monthly', remainingPercent: spendLeft, resetsAt: null,
  })
  const plan = text(account.subscriptionType, 100)
  const email = text(account.email, 254)
  return { ...base('claude', checkedAt), account: email, plan, windows: windows.slice(0, 16),
    ...providerAccountIdentity('claude', email, organization),
    status: windows.length ? 'ready' : !email && !account.apiKeySource && !account.tokenSource ? 'signed_out'
      : usage.rate_limits_available === false ? 'unsupported' : 'unavailable' }
}
