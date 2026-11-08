import { isAbsolute } from 'node:path'
import { z } from 'zod'

import { LocalCliEngineSchema, type LocalCliEngine, type LocalCliEngineRow } from '@nessie/executor-protocol'

import {
  addLocalCliAccount, localCliAccountDirectory, localCliAccountsRoot, readLocalCliAccounts, removeLocalCliAccount,
} from './local-cli-engine-accounts.js'
import { detectLocalCliEngines, type LocalCliProbes } from './local-cli-engine-detect.js'
import {
  forgetLocalCliProfile, localCliEngineKey, readLocalCliAvailability, readLocalCliStatus, setLocalCliAvailability,
} from './local-cli-engine-settings.js'
import { signInInTerminal, signOut } from './local-cli-engine-sign-in.js'
import { loadExecutorState } from './state-store.js'

/**
 * Claude Code and Codex on this computer, for one team: the rows the AI tab
 * and `ai local` show, and the operations behind their switches and buttons.
 * The plumbing verb `local-inference engines` runs these for the apps.
 */
export const LocalCliEngineOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('set'), engine: LocalCliEngineSchema, profileId: z.string().uuid().nullable(),
    available: z.boolean() }).strict(),
  z.object({ operation: z.literal('add'), engine: LocalCliEngineSchema, name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ operation: z.literal('sign-in'), profileId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('remove'), profileId: z.string().uuid() }).strict(),
])
export type LocalCliEngineOperationInput = z.infer<typeof LocalCliEngineOperation>

export class LocalCliEngineRefusal extends Error {
  constructor(readonly code: 'LOCAL_AI_NOT_INSTALLED' | 'LOCAL_AI_ACCOUNT_NOT_FOUND' | 'LOCAL_AI_ACCOUNT_NAME_TAKEN',
    message: string) { super(message) }
}

export type LocalCliEngineDependencies = {
  accountsRoot?: string
  probes?: LocalCliProbes
  env?: NodeJS.ProcessEnv
  signIn?: typeof signInInTerminal
  signOut?: typeof signOut
}

const NAMES: Record<LocalCliEngine, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

export const localCliEngineRows = async (
  stateDir: string, dependencies: LocalCliEngineDependencies = {},
): Promise<LocalCliEngineRow[]> => {
  const accountsRoot = dependencies.accountsRoot ?? localCliAccountsRoot()
  const accounts = await readLocalCliAccounts(accountsRoot)
  const [found, available, status] = await Promise.all([
    detectLocalCliEngines({ accounts, accountsRoot, ...(dependencies.env ? { env: dependencies.env } : {}),
      ...(dependencies.probes ? { probes: dependencies.probes } : {}) }),
    readLocalCliAvailability(stateDir), readLocalCliStatus(stateDir).catch(() => null),
  ])
  return found.map((row) => {
    const key = localCliEngineKey(row)
    const on = available.has(key)
    return {
      engine: row.engine, profileId: row.profileId,
      name: accounts.find((account) => account.id === row.profileId)?.name ?? null,
      installed: row.installed, signedIn: row.signedIn, ...(row.account ? { account: row.account } : {}),
      available: on, offered: !on ? 'no' : status?.offered[key] === 'yes' ? 'yes' : 'not_yet',
    }
  })
}

export const applyLocalCliEngineOperation = async (
  stateDir: string, input: unknown, dependencies: LocalCliEngineDependencies = {},
): Promise<LocalCliEngineRow[]> => {
  const action = LocalCliEngineOperation.parse(input)
  const accountsRoot = dependencies.accountsRoot ?? localCliAccountsRoot()
  const rows = () => localCliEngineRows(stateDir, dependencies)
  const accountOf = async (profileId: string) => {
    const account = (await readLocalCliAccounts(accountsRoot)).find((entry) => entry.id === profileId)
    if (!account) throw new LocalCliEngineRefusal('LOCAL_AI_ACCOUNT_NOT_FOUND', 'That account is not on this computer.')
    return account
  }
  const detectOne = async (engine: LocalCliEngine, profileId: string | null) => (await detectLocalCliEngines({
    accounts: [], accountsRoot, only: { engine, profileId },
    ...(dependencies.env ? { env: dependencies.env } : {}),
    ...(dependencies.probes ? { probes: dependencies.probes } : {}),
  }))[0]
  const programOf = async (engine: LocalCliEngine, profileId: string | null) => {
    const found = await detectOne(engine, profileId)
    if (!found?.program) {
      throw new LocalCliEngineRefusal('LOCAL_AI_NOT_INSTALLED', `${NAMES[engine]} is not installed on this computer.`)
    }
    return found
  }
  if (action.operation === 'set') {
    if (action.profileId !== null) await accountOf(action.profileId)
    if (action.available) await programOf(action.engine, action.profileId)
    await setLocalCliAvailability(stateDir, { engine: action.engine, profileId: action.profileId }, action.available)
  } else if (action.operation === 'add') {
    const found = await programOf(action.engine, null)
    let account
    try { account = await addLocalCliAccount(action.engine, action.name, accountsRoot) } catch (error) {
      if (error instanceof Error && error.message === 'cli_account_name_taken') {
        throw new LocalCliEngineRefusal('LOCAL_AI_ACCOUNT_NAME_TAKEN', `There is already a ${NAMES[action.engine]} account called ${action.name.trim()}.`)
      }
      throw error
    }
    await (dependencies.signIn ?? signInInTerminal)(action.engine, found.program!.path,
      localCliAccountDirectory(accountsRoot, account.id))
  } else if (action.operation === 'sign-in') {
    const account = await accountOf(action.profileId)
    const found = await programOf(account.engine, account.id)
    await (dependencies.signIn ?? signInInTerminal)(account.engine, found.program!.path,
      localCliAccountDirectory(accountsRoot, account.id))
  } else if (action.operation === 'remove') {
    const account = await accountOf(action.profileId)
    const found = await detectOne(account.engine, account.id)
    // Sign the profile out first, so its keychain or credential file goes with it;
    // a missing CLI leaves only the folder.
    if (found?.program) {
      await (dependencies.signOut ?? signOut)(account.engine, found.program.path, found.env,
        localCliAccountDirectory(accountsRoot, account.id)).catch(() => false)
    }
    await forgetLocalCliProfile(stateDir, account.id)
    await removeLocalCliAccount(account.id, accountsRoot)
  }
  return rows()
}

/** `local-inference engines list|--operation-stdin --state-dir <dir>`: the apps' doorway. */
export const runLocalCliEnginesCli = async (args: string[]): Promise<boolean> => {
  if (args[0] !== 'local-inference' || args[1] !== 'engines') return false
  const directory = args[4]
  if (args.length !== 5 || !['list', '--operation-stdin'].includes(args[2] ?? '')
    || args[3] !== '--state-dir' || !directory || !isAbsolute(directory)) {
    throw new Error('Usage: nessie-executor local-inference engines list|--operation-stdin --state-dir <path>')
  }
  await loadExecutorState(directory)
  let input: unknown = { operation: 'list' }
  if (args[2] === '--operation-stdin') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array)
      size += bytes.length
      if (size > 4 * 1024) throw new Error('local_cli_engine_operation_invalid')
      chunks.push(bytes)
    }
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  try {
    process.stdout.write(`${JSON.stringify(await applyLocalCliEngineOperation(directory, input))}\n`)
  } catch (error) {
    if (!(error instanceof LocalCliEngineRefusal)) throw error
    // The apps show the CLI's own last line beside the control that failed.
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
  return true
}
