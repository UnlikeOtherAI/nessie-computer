import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readQuotaFile } from './provider-process/quota-file.js'

const key = (kind: string, provider: string, value: string): string =>
  createHash('sha256').update(JSON.stringify([kind, provider, value])).digest('hex')

/** Provider identity is distinct from a Nessie/UOA profile; workspace references stay opaque. */
export const providerAccountIdentity = (provider: string, email: string | null, workspace: unknown) => ({
  ...(email?.trim() ? { accountKey: key('account', provider, email.trim().toLowerCase()) } : {}),
  ...(typeof workspace === 'string' && workspace.trim()
    ? { workspaceKey: key('workspace', provider, workspace.trim()) } : {}),
})

/** T3 Code reads only oauthAccount.organizationUuid from this CLI-owned metadata file. */
export const readClaudeOrganization = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  const directory = configured?.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
  const path = directory ? join(resolve(directory), '.claude.json') : join(homedir(), '.claude.json')
  try {
    const text = await readQuotaFile(path, 2 * 1024 * 1024)
    if (!text) return undefined
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || !('oauthAccount' in value)) return undefined
    const account = value.oauthAccount
    if (!account || typeof account !== 'object' || !('organizationUuid' in account)) return undefined
    return typeof account.organizationUuid === 'string' ? account.organizationUuid.trim() || undefined : undefined
  } catch { return undefined }
}
