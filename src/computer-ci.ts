import type { ExecutorMonitorSnapshot } from '@nessie/executor-protocol'
import { buildAgentEnvironment, runCommand, type CommandRunner } from './coding-session/agent-env.js'

type Ci = NonNullable<ExecutorMonitorSnapshot['ci']>

/** SysMon's authored-open-PR scope, using the local GitHub CLI's existing sign-in. */
export const readComputerCi = async (dependencies: {
  run?: CommandRunner; env?: NodeJS.ProcessEnv; now?: () => number
} = {}): Promise<Ci> => {
  const run = dependencies.run ?? runCommand
  const env = dependencies.env ?? await buildAgentEnvironment({
    config: { inheritUserSession: true, pass: [], set: {} },
  })
  const base: Ci = { status: 'unavailable', checkedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
    truncated: false, pullRequests: [] }
  try {
    const result = await run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', 'search/issues',
      '-f', 'q=is:pr is:open author:@me status:failure', '-f', 'per_page=30', '-f', 'sort=updated'],
    { env: { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 8_000, maxBytes: 256 * 1024 })
    if (result.missing) return { ...base, status: 'not_installed' }
    if (result.code !== 0) {
      const auth = await run('gh', ['auth', 'status', '--hostname', 'github.com'],
        { env: { ...env, GH_PROMPT_DISABLED: '1' }, timeoutMs: 4_000, maxBytes: 16 * 1024 })
      return { ...base, status: auth.code === 0 ? 'unavailable' : 'signed_out' }
    }
    const data: unknown = JSON.parse(result.stdout)
    if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) return base
    const pullRequests: Ci['pullRequests'] = data.items.slice(0, 30).flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      if (typeof row.html_url !== 'string' || typeof row.title !== 'string') return []
      try {
        const url = new URL(row.html_url)
        const match = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(url.pathname)
        if (url.origin !== 'https://github.com' || !match
          || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) return []
        return [{ repository: match[1]!.slice(0, 200), number: Number(match[2]),
          title: row.title.slice(0, 300), url: `${url.origin}${url.pathname}` }]
      } catch { return [] }
    })
    const partial = ('incomplete_results' in data && data.incomplete_results === true)
      || pullRequests.length !== Math.min(30, data.items.length)
    return { ...base, status: partial ? 'unavailable' : 'ready', pullRequests,
      truncated: partial || ('total_count' in data && typeof data.total_count === 'number' && data.total_count > 30) }
  } catch { return base }
}
