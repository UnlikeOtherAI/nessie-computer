import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'

import { buildAgentEnvironment } from './coding-session/agent-env.js'
import { findProviderProgram } from './existing-session/programs.js'
import { probeClaudeAccount } from './provider-process/claude-account.js'
import { CodexRpc } from './provider-process/codex-rpc.js'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, limit: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null
const remaining = (used: unknown): number | null =>
  typeof used === 'number' && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : null
const time = (value: unknown): string | null => {
  const epoch = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null
}
const base = (provider: ExecutorSubscription['provider'], checkedAt: string): ExecutorSubscription => ({
  provider, checkedAt, status: 'unavailable', account: null, plan: null, windows: [],
})

/** The app-server's account and rate-limit responses, projected independently. */
export const codexSubscription = (
  accountValue: unknown, limitsValue: unknown, checkedAt: string,
): ExecutorSubscription => {
  const root = object(accountValue)
  const account = object(root.account)
  if (root.account === null) return { ...base('codex', checkedAt), status: 'signed_out' }
  const limits = object(limitsValue)
  const buckets = object(limits.rateLimitsByLimitId)
  const main = object(buckets.codex ?? limits.rateLimits)
  const plan = text(main.planType ?? account.planType, 100)
  const windows: ExecutorUsageWindow[] = []
  const snapshots = Object.keys(buckets).length ? Object.entries(buckets) : [['codex', main]] as const
  for (const [bucketId, raw] of snapshots) {
    const snapshot = object(raw)
    for (const name of ['primary', 'secondary'] as const) {
      const window = object(snapshot[name])
      const left = remaining(window.usedPercent)
      if (left === null) continue
      const duration = typeof window.windowDurationMins === 'number' && window.windowDurationMins > 0
        ? window.windowDurationMins : null
      const kind = bucketId !== 'codex' ? 'other' : duration !== null
        ? duration >= 30 * 24 * 60 ? 'monthly' : duration >= 7 * 24 * 60 ? 'weekly' : 'session'
        : name === 'secondary' ? 'weekly' : plan === 'free' || plan === 'go' ? 'monthly' : 'session'
      windows.push({ id: `${bucketId}:${name}`.slice(0, 100), kind, remainingPercent: left,
        resetsAt: time(window.resetsAt), ...(duration ? { durationMinutes: duration } : {}) })
    }
    const individual = object(snapshot.individualLimit)
    const left = individual.remainingPercent
    if (typeof left === 'number' && Number.isFinite(left) && left >= 0 && left <= 100) {
      windows.push({ id: `${bucketId}:individual`.slice(0, 100), kind: 'monthly',
        remainingPercent: left, resetsAt: time(individual.resetsAt) })
    }
  }
  return { ...base('codex', checkedAt), account: text(account.email, 254), plan,
    status: windows.length ? 'ready' : account.type === 'apiKey' ? 'unsupported' : 'unavailable',
    windows: windows.slice(0, 16) }
}

export const claudeSubscription = (
  initValue: unknown, usageValue: unknown, checkedAt: string,
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
    if (id && left !== null) windows.push({ id: `model:${id}`, kind: 'other',
      remainingPercent: left, resetsAt: time(window.resets_at) })
  }
  const extra = object(limits.extra_usage)
  const used = typeof extra.used_credits === 'number' && typeof extra.monthly_limit === 'number'
    && extra.monthly_limit > 0 ? extra.used_credits / extra.monthly_limit * 100 : extra.utilization
  const spendLeft = remaining(used)
  if (extra.is_enabled === true && spendLeft !== null) windows.push({
    id: 'monthly_spend', kind: 'monthly', remainingPercent: spendLeft, resetsAt: null,
  })
  const plan = text(account.subscriptionType, 100)
  const email = text(account.email, 254)
  return { ...base('claude', checkedAt), account: email, plan, windows: windows.slice(0, 16),
    status: windows.length ? 'ready' : !email && !account.apiKeySource && !account.tokenSource ? 'signed_out'
      : usage.rate_limits_available === false ? 'unsupported' : 'unavailable' }
}

/** Uses only the local CLIs' control protocols. No token file is read or uploaded. */
export const readProviderSubscriptions = async (): Promise<ExecutorSubscription[]> => {
  const env = await buildAgentEnvironment({ config: { inheritUserSession: true, pass: [], set: {} } })
  return Promise.all((['claude', 'codex'] as const).map(async (provider) => {
    const checkedAt = new Date().toISOString()
    try {
      const program = await findProviderProgram(provider, env)
      if (!program) return { ...base(provider, checkedAt), status: 'not_installed' as const }
      if (provider === 'claude') {
        const value = await probeClaudeAccount(program.path, env)
        return claudeSubscription(value.initialization, value.usage, checkedAt)
      }
      const rpc = new CodexRpc(program.path, env)
      try {
        const account = await rpc.call('account/read', {})
        const limits = await rpc.call('account/rateLimits/read', null).catch(() => null)
        return codexSubscription(account, limits, checkedAt)
      } finally { rpc.close() }
    } catch { return base(provider, checkedAt) }
  }))
}
