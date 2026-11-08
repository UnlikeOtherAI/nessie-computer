import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExecutorSubscription, ExecutorUsageWindow } from '@nessie/executor-protocol'
import { readQuotaFile } from './quota-file.js'
import { quotaFetch } from './quota-fetch.js'
import { QuotaHttpError, quotaBase, quotaIso, quotaJson, quotaKey,
  quotaObject as object, quotaRemaining, quotaToken } from './quota-values.js'

type CredentialDatabase = {
  exec: (sql: string) => void; close: () => void
  prepare: (sql: string) => { get: (integration: string) => { value?: unknown } | undefined }
}
/** OpenCode 2's selected Console credential takes precedence over its legacy auth.json. */
export const readOpenCodeStoredKey = (path: string, integration: string): string | undefined => {
  if (!existsSync(path)) return undefined
  let database: CredentialDatabase | undefined
  try {
    const sqlite = createRequire(join(homedir(), 'nessie-quota-probe.cjs'))('node:sqlite') as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => CredentialDatabase
    }
    database = new sqlite.DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA busy_timeout = 100')
    const row = database.prepare('SELECT value FROM credential WHERE integration_id = ? AND active IS NOT 0 '
      + 'ORDER BY active DESC, time_created DESC, id DESC LIMIT 1').get(integration)
    if (typeof row?.value !== 'string' || row.value.length > 65536) return undefined
    const value = object(JSON.parse(row.value))
    const server = object(value.metadata).server
    if (typeof server === 'string') {
      const url = new URL(server)
      if (`${url.origin}${url.pathname.replace(/\/+$/u, '')}` !== 'https://opencode.ai/console') return undefined
    }
    return value.type === 'key' ? quotaToken(value.key) ?? undefined : undefined
  } catch { return undefined } finally { database?.close() }
}
export const openCodeUsageWindows = (value: unknown): ExecutorUsageWindow[] => {
  const usage = object(object(value).usage)
  return (['rolling', 'weekly', 'monthly'] as const).flatMap(id => {
    const window = object(usage[id])
    const left = quotaRemaining(window.percent)
    const at = quotaIso(window.resetsAt)
    return left === null || !at ? [] : [{ id: `go_${id}`, kind: id === 'rolling' ? 'session' : id,
      remainingPercent: left, resetsAt: at, ...(id === 'rolling' ? { durationMinutes: 300 } : {}) }]
  })
}
export const readOpenCodeQuota = async (env: NodeJS.ProcessEnv, dependencies: {
  home?: string; fetch?: typeof fetch; now?: () => number
} = {}): Promise<ExecutorSubscription | null> => {
  if (env.OPENCODE_SERVER_URL?.trim()) return null
  const home = dependencies.home ?? homedir()
  const data = env.XDG_DATA_HOME || join(home, '.local/share')
  const directory = join(data, 'opencode')
  const inline = env.OPENCODE_AUTH_CONTENT?.trim()
  const text = inline ?? await readQuotaFile(join(directory, 'auth.json'), 64 * 1024)
  let legacy: string | null = null
  try {
    const value = object(object(JSON.parse(text || '{}'))['opencode-go'])
    legacy = value.type === 'api' ? quotaToken(value.key) : quotaToken(env.OPENCODE_API_KEY)
  } catch { return null }
  const file = env.OPENCODE_DB || 'opencode.db'
  const stored = inline || file === ':memory:' ? [] : ['opencode', 'opencode-go']
    .map(integration => readOpenCodeStoredKey(resolve(directory, file), integration))
  const keys = [...new Set([...stored, legacy].filter((key): key is string => Boolean(key)))]
  if (!keys.length) return null
  const base: ExecutorSubscription = { ...quotaBase('opencode', (dependencies.now ?? Date.now)()),
    sourceKey: quotaKey('opencode', 'source', directory) }
  for (const [index, key] of keys.entries()) {
    base.accountKey = quotaKey('opencode', 'credential', key)
    try {
      const value = await quotaJson(dependencies.fetch ?? quotaFetch, 'https://opencode.ai/zen/go/v1/usage', {
        headers: { authorization: `Bearer ${key}` },
      })
      const windows = openCodeUsageWindows(value)
      return { ...base, windows, plan: windows.length ? 'Go' : null, status: windows.length ? 'ready' : 'unsupported' }
    } catch (error) {
      if (error instanceof QuotaHttpError && [401, 403].includes(error.status)) {
        if (index + 1 < keys.length) continue
        return { ...base, status: error.status === 403 ? 'unsupported' : 'signed_out' }
      }
      return base
    }
  }
  return base
}
