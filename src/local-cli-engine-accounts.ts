import { randomUUID } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { LocalCliEngineSchema, type LocalCliEngine } from '@nessie/executor-protocol'

import { replaceOwnerOnlyJson } from './owner-only-json.js'
import { acquireOwnerStateLock } from './personal-admission-lock.js'
import { assertOwnerOnlyStatePath, ensureOwnerOnlyStateDirectory } from './state-security.js'

/**
 * Claude Code and Codex accounts added in Nessie Computer (contract §12, "more
 * accounts"). Each is the CLI's own sign-in in a profile directory this app
 * owns — `CLAUDE_CONFIG_DIR` or `CODEX_HOME` — never a credential this app
 * reads. They are computer-wide; whether a team may use one is the team's
 * Make available switch.
 */
export type LocalCliAccount = { id: string; engine: LocalCliEngine; name: string; createdAt: string }

const FILE = 'accounts.json'
const Account = z.object({
  id: z.string().uuid(), engine: LocalCliEngineSchema, name: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(),
}).strict()
const Collection = z.object({ version: z.literal(1), accounts: z.array(Account).max(16) }).strict()

export const localCliAccountsRoot = (): string => join(homedir(), '.nessie', 'cli-accounts')

export const localCliAccountDirectory = (root: string, id: string): string => join(root, z.string().uuid().parse(id))

/** The CLI's own home for an added account; the default account keeps the owner's environment. */
export const localCliAccountEnvironment = (
  engine: LocalCliEngine, env: NodeJS.ProcessEnv, directory: string | null,
): NodeJS.ProcessEnv => {
  if (directory === null) return env
  const next = { ...env }
  const name = engine === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === name || engine === 'claude-code' && key.toUpperCase() === 'CLAUDE_SECURESTORAGE_CONFIG_DIR') {
      delete next[key]
    }
  }
  next[name] = directory
  return next
}

export const readLocalCliAccounts = async (root: string = localCliAccountsRoot()): Promise<LocalCliAccount[]> => {
  const path = join(root, FILE)
  try { await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  await assertOwnerOnlyStatePath(root, 'directory')
  await assertOwnerOnlyStatePath(path, 'file')
  const bytes = await readFile(path)
  if (bytes.length > 64 * 1024) throw new Error('cli_accounts_invalid')
  return Collection.parse(JSON.parse(bytes.toString('utf8'))).accounts
}

const change = async <T>(root: string, edit: (accounts: LocalCliAccount[]) => Promise<T>): Promise<T> => {
  await ensureOwnerOnlyStateDirectory(root)
  const lease = await acquireOwnerStateLock(root, 'cli-accounts.lock')
  try {
    const accounts = await readLocalCliAccounts(root)
    const answer = await edit(accounts)
    await replaceOwnerOnlyJson(join(root, FILE), Collection.parse({ version: 1, accounts }))
    return answer
  } finally { await lease.release() }
}

/** Names are unique per engine, ignoring case, so `--account <name>` is never ambiguous. */
export const addLocalCliAccount = async (
  engine: LocalCliEngine, name: string, root: string = localCliAccountsRoot(), now: () => Date = () => new Date(),
): Promise<LocalCliAccount> => change(root, async (accounts) => {
  const trimmed = Account.shape.name.parse(name)
  if (accounts.some((account) => account.engine === engine && account.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('cli_account_name_taken')
  }
  const account = { id: randomUUID(), engine, name: trimmed, createdAt: now().toISOString() }
  await ensureOwnerOnlyStateDirectory(localCliAccountDirectory(root, account.id))
  accounts.push(account)
  return account
})

/** Forgets the account and deletes its profile directory; the caller signs it out first. */
export const removeLocalCliAccount = async (id: string, root: string = localCliAccountsRoot()): Promise<boolean> =>
  change(root, async (accounts) => {
    const index = accounts.findIndex((account) => account.id === id)
    if (index < 0) return false
    accounts.splice(index, 1)
    await rm(localCliAccountDirectory(root, id), { recursive: true, force: true })
    return true
  })

/** `--account` takes the owner's name for the account or its id. */
export const findLocalCliAccount = (
  accounts: LocalCliAccount[], engine: LocalCliEngine | undefined, reference: string,
): LocalCliAccount | undefined => {
  const wanted = reference.trim().toLowerCase()
  const matches = accounts.filter((account) => (engine === undefined || account.engine === engine)
    && (account.id === wanted || account.name.toLowerCase() === wanted))
  return matches.length === 1 ? matches[0] : undefined
}
