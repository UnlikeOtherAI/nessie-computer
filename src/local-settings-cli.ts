import { homedir } from 'node:os'
import { existingSessionsEnabled, setExistingSessionsEnabled } from './existing-session/settings.js'
import { resolve } from 'node:path'

import { localCommandPolicyOf } from './command-policy.js'
import { defaultPairingDirectory } from './pairing-code-directory.js'
import { pairingCodeStatus } from './pairing-code.js'
import { configureExecutorLocalPolicy } from './pair.js'
import { loadExecutorState, loadExecutorStatesFromRoot } from './state-store.js'
import { serveExecutor } from './daemon-server.js'
import { assertPackagedExecutorRuntime } from './runtime-integrity.js'

const value = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const found = args[index + 1]
  if (!found || found.startsWith('--')) throw new Error(`Provide a value for ${flag}.`)
  return found
}

export const runLocalSettingsCli = async (args: string[]): Promise<boolean> => {
  if (!['teams', 'permissions', 'daemon'].includes(args[0] ?? '')) return false
  if (args[0] === 'teams') {
    const root = value(args, '--state-root') ?? resolve(homedir(), '.local/state/nessie-executor')
    const states = await loadExecutorStatesFromRoot(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const rows = await Promise.all(states.map(async (state) => {
      const identity = await pairingCodeStatus(resolve(root, state.executorId)).catch(() => null)
      return { executorId: state.executorId, apiBaseUrl: state.apiBaseUrl,
        organizationName: identity?.organizationName ?? null, teamName: identity?.teamName ?? null }
    }))
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(rows)}\n`)
    else if (!rows.length) process.stdout.write('No teams paired. Run nessie-executor login to get a code.\n')
    else for (const row of rows) process.stdout.write(
      `${row.organizationName ?? 'Server unavailable'} / ${row.teamName ?? 'Team unavailable'}\n  ${row.executorId} · ${row.apiBaseUrl}\n`,
    )
    return true
  }
  const executorId = value(args, '--executor')
  const explicit = value(args, '--state-dir')
  if (!explicit && !executorId) throw new Error('Select a connection with --executor <id> from teams, or --state-dir <path>.')
  const directory = explicit ?? await defaultPairingDirectory(executorId)
  const state = await loadExecutorState(directory)
  if (args[0] === 'daemon') {
    await assertPackagedExecutorRuntime()
    await serveExecutor(directory, state)
    return true
  }
  const existing = value(args, '--existing-sessions')
  if (existing !== undefined && existing !== 'on' && existing !== 'off') throw new Error('Use --existing-sessions on|off.')
  if (existing !== undefined) {
    await setExistingSessionsEnabled(directory, existing === 'on')
    process.stdout.write(`Existing coding sessions ${existing === 'on' ? 'enabled' : 'disabled'} on this connection.\n`)
  }
  const current = localCommandPolicyOf(state)
  const allow = value(args, '--allow')
  const deny = value(args, '--deny')
  if (allow !== undefined && args.includes('--allow-all')) throw new Error('Choose --allow or --allow-all.')
  if (deny !== undefined && args.includes('--clear-deny')) throw new Error('Choose --deny or --clear-deny.')
  if (allow !== undefined || deny !== undefined || args.includes('--allow-all') || args.includes('--clear-deny')) {
    const policy = {
      mode: args.includes('--allow-all') ? 'all' as const : allow !== undefined ? 'allowlist' as const : current.mode,
      allowlist: allow === undefined ? current.allowlist : allow.split(',').map((rule) => rule.trim()).filter(Boolean),
      denylist: args.includes('--clear-deny') ? [] : deny === undefined ? current.denylist : deny.split(',').map((rule) => rule.trim()).filter(Boolean),
    }
    await configureExecutorLocalPolicy(directory, state, state.descriptor.operationKeys,
      undefined, undefined, undefined, undefined, undefined, {}, policy)
    process.stdout.write('Permissions saved on this computer. Restart its daemon to apply them.\n')
  } else if (existing === undefined) process.stdout.write(`${JSON.stringify({ ...current,
    existingCodingSessionsEnabled: await existingSessionsEnabled(directory) }, null, 2)}\n`)
  return true
}
