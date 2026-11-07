import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ExecutorSubscription } from '@nessie/executor-protocol'
import { quotaFetch } from './quota-fetch.js'
import { readQuotaFile } from './quota-file.js'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** SysMon owns its Grok website browser and login; only derived quota facts cross this local read-only API. */
export const sysmonGrokSubscription = (value: unknown, checkedAt: string): ExecutorSubscription => {
  const account = record(value)
  const sampled = account.lastSuccessAt ?? account.sampledAt
  const at = typeof sampled === 'number' && Number.isFinite(sampled) && sampled > 0 && sampled < 8.64e15
    ? new Date(sampled).toISOString() : checkedAt
  const windows: ExecutorSubscription['windows'] = (Array.isArray(account.windows) ? account.windows : [])
    .slice(0, 16).flatMap(raw => {
      const window = record(raw)
      if (typeof window.used !== 'number' || !Number.isFinite(window.used) || window.used < 0 || window.used > 100) return []
      const reset = typeof window.resetAt === 'number' && Number.isFinite(window.resetAt)
        && window.resetAt > 0 && window.resetAt < 8.64e15 ? new Date(window.resetAt).toISOString() : null
      return [{ id: typeof window.label === 'string' ? window.label.slice(0, 100) || 'grok' : 'grok',
        ...(typeof window.label === 'string' && window.label ? { label: window.label.slice(0, 100) } : {}),
        kind: 'other' as const, remainingPercent: 100 - window.used, resetsAt: reset }]
    })
  return { provider: 'grok', source: 'sysmon', account: null, plan: null, checkedAt: at, windows,
    status: account.status === 'live' && windows.length ? 'ready'
      : account.status === 'auth' ? 'signed_out' : 'unavailable' }
}

export const readGrokQuota = async (env: NodeJS.ProcessEnv): Promise<ExecutorSubscription | null> => {
  const base = platform() === 'win32' ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const paths = env.SYSMON_MCP_TOKEN_FILE ? [env.SYSMON_MCP_TOKEN_FILE]
    : env.SYSMON_USERDATA ? [join(env.SYSMON_USERDATA, 'mcp-token')]
      : ['SysMon', 'sysmon'].map(name => join(base, name, 'mcp-token'))
  let token: string | undefined
  for (const path of paths) {
    try {
      token = (await readQuotaFile(path, 512))?.trim()
      if (token && /^[A-Za-z0-9_-]{43,256}$/u.test(token)) break
      token = undefined
    } catch { /* An absent installation is not a fabricated Grok account. */ }
  }
  if (!token) return null
  const checkedAt = new Date().toISOString()
  const client = new Client({ name: 'nessie-computer-quotas', version: '1.0.0' })
  const deadline = AbortSignal.timeout(8_000)
  try {
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7738/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, options = {}) => quotaFetch(input, { ...options,
        signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]) }),
    })
    await client.connect(transport)
    const result = await client.callTool({ name: 'get_accounts', arguments: { vendor: 'Grok' } })
    if (result.isError) return sysmonGrokSubscription(null, checkedAt)
    const structured = record(result.structuredContent)
    const items = Array.isArray(structured.items) ? structured.items : []
    const grok = items.find(value => record(value).vendor === 'Grok')
    return grok ? sysmonGrokSubscription(grok, checkedAt) : null
  } catch { return sysmonGrokSubscription(null, checkedAt) }
  finally { await client.close().catch(() => undefined) }
}
