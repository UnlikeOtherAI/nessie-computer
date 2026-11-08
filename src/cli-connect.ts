import { approveExecutorPairingOrigin } from '@nessie/executor-protocol'

import { acceptOnly, operands } from './cli-options.js'
import { CliRefusal, CliTimeout, CliUsageError, printJson, type CliContext } from './cli-output.js'
import { retireMacLaunchAgent, startNewTeam } from './cli-team-runner.js'
import { findPendingConnections, labelFor, selectTeam } from './cli-teams.js'
import type { CliRun } from './cli-user.js'
import { defaultExecutorWorkspaceFolders } from './default-workspace-folders.js'
import { defaultPairingDirectory, promoteDefaultPairing } from './pairing-code-directory.js'
import { pairingCodeStatus, pairingOperationKeys, startPairingCode, type PairingCodeView } from './pairing-code.js'
import { localDevelopmentApiOrigin } from './pairing-origin.js'
import { acquireExecutorProcessLease } from './process-lease.js'
import { createExecutorServiceEnvironment, executorServiceStateRoot } from './service-environment.js'
import { ensureOwnerOnlyStateDirectory } from './state-security.js'
import { disableExecutorServiceIfPresent } from './service-linux.js'

/**
 * Connect a team and Disconnect, on the operations `login` and `unpair` use:
 * the pairing code client and the default pairing folder. The new team is
 * handed to whoever runs this computer's teams (`cli-team-runner.ts`): the
 * app where it is installed, otherwise the command line's own service.
 */

const POLL_MS = 3_000

/**
 * The lease `login` and `unpair` hold over the command line's teams folder
 * (`acquireDefaultPairingLease`), taken in this context's home folder.
 */
const pairingLease = async (home: string) => acquireExecutorProcessLease(
  await ensureOwnerOnlyStateDirectory(executorServiceStateRoot(home)), 'pairing-operation.pid')

const codeText = (code: string | undefined): string => (code ? `${code.slice(0, 4)} ${code.slice(4)}` : '')

const label = (view: PairingCodeView): string => labelFor(
  { teamName: view.teamName ?? null, organizationName: view.organizationName ?? null },
  view.apiBaseUrl ? new URL(view.apiBaseUrl).host : '', [],
)

/** A pairing Nessie confirmed: moved to its own folder and started. */
const finish = async (context: CliContext, directory: string, view: PairingCodeView): Promise<string> => {
  await promoteDefaultPairing(directory, view.executorId!)
  return startNewTeam(context, view.executorId!)
}

export type PendingConnection = { code: string | null; expiresAt: string | null }

/**
 * Pairings `connect --no-wait` left waiting. Nessie's claim completes a
 * pairing only when this computer next asks, so `status` and `teams` ask, and
 * finish any that Nessie confirmed. A pairing another command is handling is
 * left to it.
 */
export const advancePendingConnections = async (context: CliContext): Promise<PendingConnection[]> => {
  const directories = await findPendingConnections(context.home)
  if (!directories.length) return []
  const lease = await pairingLease(context.home).catch(() => null)
  if (!lease) return directories.map(() => ({ code: null, expiresAt: null }))
  try {
    const waiting: PendingConnection[] = []
    for (const directory of directories) {
      const view = await pairingCodeStatus(directory).catch(() => null)
      if (view?.status === 'paired' && view.executorId) {
        const started = await finish(context, directory, view)
        context.err(`Connected to ${label(view)}. ${started}\n`)
      } else if (view?.status === 'waiting') waiting.push({ code: codeText(view.code), expiresAt: view.expiresAt ?? null })
    }
    return waiting
  } finally { await lease.release() }
}

const connect = async (run: CliRun): Promise<void> => {
  const { context, options } = run
  acceptOnly(options, 'connect', ['--server', '--no-wait'])
  operands(options, 1, 0, 'connect')
  const approved = approveExecutorPairingOrigin(options.values.get('--server') ?? 'nessie', {
    allowLocalDevelopment: process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1',
    localDevelopmentOrigin: localDevelopmentApiOrigin(),
  })
  if (!approved.ok) throw new CliUsageError(approved.reason, 'connect')
  const lease = await pairingLease(context.home)
  try {
    const directory = await defaultPairingDirectory()
    let view = await startPairingCode({ apiBaseUrl: approved.origin, operationKeys: pairingOperationKeys(undefined),
      replace: false, stateDir: directory, workspaceFolders: await defaultExecutorWorkspaceFolders() })
    if (view.status !== 'waiting') throw new CliRefusal('PAIRING_NOT_STARTED', 'Nessie didn\'t give a pairing code. Try again.')
    if (!options.json) {
      context.out(`Pairing code: ${codeText(view.code)}   (valid for 10 minutes)\n`
        + 'In Nessie, open Computers and choose Add a computer, then enter the code.\n')
    }
    if (options.flags.has('--no-wait')) {
      if (options.json) printJson(context, { status: 'waiting', code: view.code, expiresAt: view.expiresAt })
      else context.out('Run nessie-computer status to see when it\'s done.\n')
      return
    }
    if (!options.json) context.out('Waiting for Nessie…\n')
    while (view.status === 'waiting') {
      await context.sleep(POLL_MS)
      view = await pairingCodeStatus(directory)
    }
    if (view.status === 'expired') {
      throw new CliTimeout('The pairing code expired before it was entered. Run nessie-computer connect for a new one.')
    }
    if (view.status !== 'paired' || !view.executorId) throw new CliRefusal('PAIRING_CANCELLED', 'Nessie turned down this pairing.')
    const started = await finish(context, directory, view)
    if (options.json) {
      printJson(context, { status: 'paired', executorId: view.executorId, label: label(view),
        teamName: view.teamName ?? null, organizationName: view.organizationName ?? null })
    } else context.out(`Connected to ${label(view)}.${started ? `\n${started}` : ''}\n`)
  } finally { await lease.release() }
}

const disconnect = async (run: CliRun): Promise<void> => {
  const { context, options } = run
  acceptOnly(options, 'disconnect', ['--yes'])
  operands(options, 1, 0, 'disconnect')
  if (options.team === undefined) {
    throw new CliUsageError('Name the team to disconnect with --team.', 'disconnect')
  }
  const team = selectTeam(await run.teams(), options.team, 'disconnect')
  if (!options.flags.has('--yes')) {
    if (!context.interactive) throw new CliUsageError('Add --yes to disconnect without being asked.', 'disconnect')
    const answer = await context.ask(`Disconnect ${team.label}? Its agents lose access to this computer and its settings `
      + 'here are deleted. Your own files stay. Type yes to continue: ')
    if (answer.trim().toLowerCase() !== 'yes') throw new CliRefusal('NOT_CONFIRMED', 'Nothing was changed.')
  }
  const cliService = team.route === 'local' && team.cliService
  const lease = cliService ? await pairingLease(context.home) : null
  try {
    if (cliService && context.platform === 'darwin') await retireMacLaunchAgent(context, team.executorId)
    if (cliService && context.platform === 'linux') {
      await disableExecutorServiceIfPresent({ executorId: team.executorId },
        { ...createExecutorServiceEnvironment(), write: () => undefined })
    }
    const result = await run.ops(team).remove().catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('This connection is running.')) {
        throw new CliRefusal('TEAM_RUNNING', `Nessie Computer is running ${team.label}. `
          + 'Disconnect it in the app, or quit the app and try again.')
      }
      throw error
    })
    if (options.json) printJson(context, { executorId: team.executorId, label: team.label, ...result })
    else {
      context.out(result.signedOff ? `Disconnected ${team.label}. Nessie shows this computer as disconnected for that team.\n`
        : `Disconnected ${team.label} on this computer. Nessie couldn't be told, so it shows the computer as offline.\n`)
    }
  } finally { await lease?.release() }
}

export const CONNECTING: Record<string, (run: CliRun) => Promise<void>> = { connect, disconnect }
