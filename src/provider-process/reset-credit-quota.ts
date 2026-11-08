import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { ExecutorSubscription } from '@nessie/executor-protocol'
import { readQuotaFile } from './quota-file.js'
import { quotaFetch } from './quota-fetch.js'
import { quotaIso, quotaJson, quotaObject as object, quotaToken } from './quota-values.js'

type Credits = ExecutorSubscription['resetCredits']
export const codexResetCredits = (value: unknown): Credits => {
  const summary = object(value)
  const count = summary.availableCount
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined
  const expiries = (Array.isArray(summary.credits) ? summary.credits : []).slice(0, 128).map(object)
    .filter(credit => credit.status === 'available' && typeof credit.expiresAt === 'number')
    .flatMap(credit => { const iso = quotaIso(Number(credit.expiresAt) * 1000); return iso ? [iso] : [] }).sort()
  return { availableCount: count, ...(expiries[0] ? { nextExpiresAt: expiries[0] } : {}) }
}
export const claudeResetCredits = (value: unknown, now: number): Credits => {
  const block = object(value)
  if (block.eligible !== true) return undefined
  const live = (Array.isArray(block.grants) ? block.grants : []).slice(0, 128).map(object).filter(grant =>
    typeof grant.id === 'string' && /^[a-z0-9_-]{1,40}$/u.test(grant.id)
      && grant.paused !== true && grant.usable_now === true && typeof grant.resets_left === 'number'
      && Number.isSafeInteger(grant.resets_left) && grant.resets_left >= 0
      && (grant.ends_at == null || (quotaIso(grant.ends_at) && Date.parse(String(grant.ends_at)) > now)))
  const next = live.find(grant => typeof grant.id === 'string' && grant.id === block.next_grant_id)
  const count = next ? live.reduce((sum, grant) => sum + Number(grant.resets_left), 0) : 0
  if (!Number.isSafeInteger(count)) return undefined
  const expiry = quotaIso(next?.ends_at)
  return { availableCount: count, ...(expiry ? { nextExpiresAt: expiry } : {}) }
}
/** Read counts only. No reset-credit redemption or grant identifiers leave this collector. */
export const readClaudeResetCredits = async (env: NodeJS.ProcessEnv, version: string,
  dependencies: { home?: string; fetch?: typeof fetch; now?: () => number; platform?: string } = {},
): Promise<Credits> => {
  if ((dependencies.platform ?? platform()) === 'darwin'
    || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(name => env[name]?.trim())) return undefined
  const home = dependencies.home ?? homedir()
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  const directory = configured?.startsWith('~/') ? join(home, configured.slice(2)) : configured || join(home, '.claude')
  try {
    const text = await readQuotaFile(join(directory, '.credentials.json'), 64 * 1024)
    const token = quotaToken(object(object(JSON.parse(text || '{}')).claudeAiOauth).accessToken)
    const release = /^\d+\.\d+\.\d+/u.exec(version)?.[0]
    if (!token || !release) return undefined
    const body = object(await quotaJson(dependencies.fetch ?? quotaFetch,
      'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': `claude-cli/${release} (external, cli)` },
      }))
    return claudeResetCredits(body.cedar_ember, (dependencies.now ?? Date.now)())
  } catch { return undefined }
}
