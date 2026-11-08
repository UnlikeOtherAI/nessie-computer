import { LocalCliEngineSchema, type LocalCliEngine, type LocalCliEngineRow } from '@nessie/executor-protocol'

import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliUsageError, columns, printJson } from './cli-output.js'
import type { CliRun } from './cli-user.js'
import { findLocalCliAccount, localCliAccountsRoot, readLocalCliAccounts } from './local-cli-engine-accounts.js'
import {
  applyLocalCliEngineOperation, LocalCliEngineRefusal, type LocalCliEngineOperationInput,
} from './local-cli-engine-cli.js'
import { signInHere } from './local-cli-engine-sign-in.js'
import { ownerCliEnvironment } from './local-cli-engine-detect.js'

/**
 * `ai local`: Claude Code and Codex on this computer, as the AI tab's **On this
 * computer** section shows them, through the same operations the apps run
 * (`local-inference engines`). Make available is per team; accounts added
 * here are this computer's and sign in with the CLI's own sign-in.
 */

const NAMES: Record<LocalCliEngine, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
const COMMAND = 'ai local'

const engineOf = (word: string | undefined): LocalCliEngine => {
  const parsed = LocalCliEngineSchema.safeParse(word)
  if (!parsed.success) throw new CliUsageError('Name the engine: claude-code or codex.', COMMAND)
  return parsed.data
}

const describeRow = (row: LocalCliEngineRow): string[] => {
  const name = row.name ? `${NAMES[row.engine]} · ${row.name}` : NAMES[row.engine]
  const program = row.engine === 'claude-code' ? 'claude' : 'codex'
  if (!row.installed) return [name, 'Not installed on this computer']
  if (!row.signedIn) {
    return [name, row.name ? `Signed out. Run nessie-computer ai local sign-in "${row.name}".`
      : `Signed out. Run ${program} once to sign in.`]
  }
  const offer = !row.available ? 'Make available: off'
    : row.offered === 'yes' ? 'Make available: on' : 'Make available: on (Nessie doesn\'t offer this yet)'
  return [name, row.account ?? 'Signed in', offer]
}

export const runAiLocal = async (run: CliRun): Promise<void> => {
  const [action = 'list', ...rest] = operands(run.options, 2, 3, COMMAND)
  acceptOnly(run.options, COMMAND, action === 'on' || action === 'off' ? ['--account'] : [])
  const team = await run.team()
  if (team.route !== 'local') {
    throw new CliRefusal('LOCAL_AI_SERVICE_TEAM', `${team.label} runs in the Nessie Computer service, `
      + 'which can\'t use your Claude Code or Codex sign-in.')
  }
  const accountsRoot = localCliAccountsRoot()
  const account = async (reference: string | undefined, engine?: LocalCliEngine) => {
    if (!reference) throw new CliUsageError('Name the account, in quotes when it has spaces.', COMMAND)
    const found = findLocalCliAccount(await readLocalCliAccounts(accountsRoot), engine, reference)
    if (!found) throw new CliRefusal('LOCAL_AI_ACCOUNT_NOT_FOUND', `This computer has no account called ${reference}.`)
    return found
  }
  let operation: LocalCliEngineOperationInput
  if (action === 'list') {
    if (rest.length) throw new CliUsageError('ai local list takes nothing after it.', COMMAND)
    operation = { operation: 'list' }
  } else if (action === 'on' || action === 'off') {
    if (rest.length !== 1) throw new CliUsageError(`Use ai local ${action} claude-code|codex.`, COMMAND)
    const engine = engineOf(rest[0])
    const named = run.options.values.get('--account')
    operation = { operation: 'set', engine, available: action === 'on',
      profileId: named === undefined ? null : (await account(named, engine)).id }
  } else if (action === 'add') {
    if (rest.length !== 2) throw new CliUsageError('Use ai local add claude-code|codex "<name>".', COMMAND)
    operation = { operation: 'add', engine: engineOf(rest[0]), name: rest[1]! }
  } else if (action === 'sign-in' || action === 'remove') {
    if (rest.length !== 1) throw new CliUsageError(`Use ai local ${action} "<account>".`, COMMAND)
    operation = { operation: action, profileId: (await account(rest[0])).id }
  } else throw new CliUsageError(`ai local has no "${action}". Use list, on, off, add, sign-in or remove.`, COMMAND)
  if ((operation.operation === 'add' || operation.operation === 'sign-in') && !run.context.interactive) {
    throw new CliUsageError(`Run ai local ${action} in a terminal: it shows the provider's own sign-in.`, COMMAND)
  }
  const env = await ownerCliEnvironment()
  let rows: LocalCliEngineRow[]
  try {
    rows = await applyLocalCliEngineOperation(team.stateDir, operation, { accountsRoot,
      signIn: async (engine, program, directory) => {
        if (await signInHere(engine, program, env, directory) !== 0) {
          run.context.out('The sign-in did not finish. Try again with nessie-computer ai local sign-in.\n')
        }
      } })
  } catch (error) {
    if (error instanceof LocalCliEngineRefusal) throw new CliRefusal(error.code, error.message)
    throw error
  }
  if (run.options.json) {
    printJson(run.context, rows)
    return
  }
  run.context.out(`On this computer, for ${team.label}:\n${columns(rows.map(describeRow), '  ')}\n`)
}
