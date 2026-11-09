import type { ExecutorSubscription } from '@nessie/executor-protocol'

import { buildAgentEnvironment } from './coding-session/agent-env.js'
import { findProviderProgram } from './existing-session/programs.js'
import { probeClaudeAccount } from './provider-process/claude-account.js'
import { readCodexSubscription } from './provider-process/codex-account.js'
import { readClaudeOrganization } from './provider-account-identity.js'
import { readKimiQuota } from './provider-process/kimi-quota.js'
import { readGrokQuota } from './provider-process/grok-quota.js'
import { readCursorQuota } from './provider-process/cursor-quota.js'
import { readOpenCodeQuota } from './provider-process/opencode-quota.js'
import { readGrokBuildQuota } from './provider-process/grok-build-quota.js'
import { readAntigravityQuotas } from './provider-process/antigravity-quota.js'
import { readCliProxyQuotas } from './provider-process/cliproxy-quota.js'
import { readClaudeResetCredits } from './provider-process/reset-credit-quota.js'
import { quotaBase, quotaKey, type QuotaAccounts } from './provider-process/quota-values.js'
import { claudeSubscription } from './provider-process/cli-quota-projection.js'
import { collectQuotaSources } from './provider-process/quota-source-collection.js'

const base = (provider: ExecutorSubscription['provider'], checkedAt: string) => quotaBase(provider, Date.parse(checkedAt), 'cli')

/** Claude/Codex use the CLIs' control protocols; additional read-only sources never upload credentials. */
export const readProviderSubscriptions = async (): Promise<QuotaAccounts> => {
  const env = await buildAgentEnvironment({ config: { inheritUserSession: true, pass: [], set: {} } })
  const native = Promise.all((['claude', 'codex'] as const).map(async (provider) => {
    const checkedAt = new Date().toISOString()
    const sourceKey = quotaKey(provider, 'source', provider === 'claude'
      ? env.CLAUDE_CONFIG_DIR || 'native-user-home' : env.CODEX_HOME || 'native-user-home')
    try {
      const program = await findProviderProgram(provider, env)
      if (!program) return { ...base(provider, checkedAt), status: 'not_installed' as const }
      if (provider === 'claude') {
        const value = await probeClaudeAccount(program.path, env)
        const subscription = claudeSubscription(value.initialization, value.usage, checkedAt,
          await readClaudeOrganization(env))
        const resetCredits = subscription.status === 'ready' ? await readClaudeResetCredits(env, program.version) : undefined
        return { ...subscription, sourceKey, ...(resetCredits ? { resetCredits } : {}) }
      }
      return { ...await readCodexSubscription(program.path, env, checkedAt), sourceKey }
    } catch { return { ...base(provider, checkedAt), sourceKey } }
  }))
  const single = (read: Promise<ExecutorSubscription | null>): Promise<QuotaAccounts> =>
    read.then(value => ({ accounts: value ? [value] : [], incomplete: false }))
  const collected = await collectQuotaSources([
    native.then(accounts => ({ accounts, incomplete: false })),
    ...[readKimiQuota(env), readGrokQuota(env), readCursorQuota(env),
      readOpenCodeQuota(env), readGrokBuildQuota(env)].map(single),
    readAntigravityQuotas(env), readCliProxyQuotas(env),
  ])
  return { ...collected, accounts: collected.accounts.filter(value => value.status !== 'not_installed') }
}
