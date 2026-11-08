import { createInterface } from 'node:readline/promises'

import { approveExecutorPairingOrigin } from '@nessie/executor-protocol'

import {
  cancelPairingCode, pairingCodeStatus, pairingOperationKeys, startPairingCode, type PairingCodeView,
} from './pairing-code.js'
import { localDevelopmentApiOrigin } from './pairing-origin.js'
import { defaultExecutorWorkspaceFolders } from './default-workspace-folders.js'
import { workspaceFoldersFromInput, type ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'
import { acquireDefaultPairingLease, defaultPairingDirectory, promoteDefaultPairing } from './pairing-code-directory.js'
import { processContext } from './cli-output.js'
import { retireMacLaunchAgent, startNewTeam } from './cli-team-runner.js'
import { createExecutorServiceEnvironment } from './service-environment.js'
import { disableExecutorServiceIfPresent } from './service-linux.js'
import { unpairExecutor } from './unpair.js'
import { WorkspaceCleanupRequiredError } from './workspace-retirement.js'

const value = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const selected = args[index + 1]
  if (!selected || selected.startsWith('--')) throw new Error('The command is missing a required setting.')
  return selected
}

const stdin = async (): Promise<Record<string, unknown>> => {
  let text = ''
  for await (const part of process.stdin) {
    text += String(part)
    if (text.length > 65_536) throw new Error('The pairing request is too large.')
  }
  const input: unknown = JSON.parse(text)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pairing input is invalid.')
  return input as Record<string, unknown>
}

/** A caller that names no folder gets the defaults, on every platform and in every client. */
const requestedFolders = async (input: Record<string, unknown>): Promise<ExecutorWorkspaceFolder[]> => (
  input.workspaceRoot === undefined && input.workspaceFolders === undefined
    ? defaultExecutorWorkspaceFolders()
    : workspaceFoldersFromInput(input, 'Workspace folder')
)

/** `{team} · {organisation}`, the label every surface uses (contract §2). */
const destination = (view: PairingCodeView): string => [view.teamName, view.organizationName].filter(Boolean).join(' · ') || 'Nessie'

/** The terminal's Connect a team: the code and where to enter it (contract §3.3). No fingerprint. */
const show = (view: PairingCodeView): void => {
  if (view.status === 'waiting') {
    const code = view.code ?? ''
    process.stdout.write(`Pairing code: ${code.slice(0, 4)} ${code.slice(4)}   (valid for 10 minutes)\n`)
    process.stdout.write('In Nessie, open Computers and choose Add a computer, then enter the code.\n')
  } else if (view.status === 'paired') {
    process.stdout.write(`Connected to ${destination(view)}.\n`)
  } else if (view.status === 'alreadyPaired') {
    process.stdout.write(`This computer is already connected to ${destination(view)}.\n`)
  } else {
    process.stdout.write(view.status === 'expired'
      ? 'The pairing code expired. Run nessie-computer connect for a new one.\n' : 'Connecting was cancelled.\n')
  }
}

/** An explicit --cli connection runs under this OS account on Windows too. */
export const pairingUsesWindowsTray = (args: string[], platform: NodeJS.Platform): boolean => (
  platform === 'win32'
  && ['pair', 'pairing-start'].includes(args[0] ?? 'pair')
  && !args.some((argument) => ['--cli', '--state-dir', '--json', '--enrollment'].includes(argument))
)

/**
 * `unpair --executor <id>` removes a CLI connection, turning its login service
 * off first; `unpair --state-dir <dir>` is how the apps remove one they run.
 */
const runUnpair = async (args: string[], platform: NodeJS.Platform): Promise<void> => {
  const explicitDirectory = value(args, '--state-dir')
  const executorId = value(args, '--executor')
  if (!explicitDirectory && !executorId) {
    throw new Error('Choose the team to remove with --executor <id> (nessie-computer teams shows the ids), or --state-dir.')
  }
  const rootLease = explicitDirectory ? null : await acquireDefaultPairingLease()
  try {
    const directory = explicitDirectory ?? await defaultPairingDirectory(executorId)
    if (!explicitDirectory && executorId && platform === 'darwin') await retireMacLaunchAgent(processContext(), executorId)
    if (!explicitDirectory && executorId && platform === 'linux') {
      await disableExecutorServiceIfPresent(
        { executorId }, { ...createExecutorServiceEnvironment(), write: () => undefined },
      )
    }
    const result = await unpairExecutor(directory)
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`)
    else {
      process.stdout.write(result.signedOff
        ? 'Removed. Nessie now shows this computer as disconnected for that team.\n'
        : 'Removed from this computer. Nessie could not be told, so it will show the computer as offline.\n')
    }
  } finally { await rootLease?.release() }
}

/** Native clients consume JSON; a terminal gets one complete guided pairing flow. */
export const runPairingCodeCli = async (
  args: string[], platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  const command = args[0] ?? 'pair'
  if (command === 'unpair') {
    await runUnpair(args, platform)
    return true
  }
  if (!['login', 'pairing-start', 'pairing-status', 'pairing-confirm', 'pairing-cancel', 'pair'].includes(command)) return false
  if (command === 'pair' && args.includes('--enrollment')) return false
  if (pairingUsesWindowsTray(args, platform)) {
    process.stdout.write('Run nessie-computer connect, or open Nessie Computer and choose Connect a team.\n')
    return true
  }
  const explicitDirectory = value(args, '--state-dir')
  const executorId = value(args, '--executor')
  if (args.includes('--replace') && !explicitDirectory && !executorId) {
    throw new Error('Choose the team to replace with --executor <id> (nessie-computer teams shows the ids), or --state-dir.')
  }
  const json = args.includes('--json')
  const rootLease = explicitDirectory ? null : await acquireDefaultPairingLease()
  try {
    const directory = explicitDirectory ?? await defaultPairingDirectory(executorId)
    let view: PairingCodeView
    // A claim in Nessie completes the pairing, so there is nothing left to
    // confirm here. `pairing-confirm` stays only for native hosts released
    // before that — the macOS menu bar app, the Windows tray and Nessie
    // Desktop's companion, which may update apart from this runtime — and it
    // answers exactly as a status check does; `--claim-digest` is ignored.
    if (command === 'pairing-status' || command === 'pairing-confirm') view = await pairingCodeStatus(directory)
    else if (command === 'pairing-cancel') view = await cancelPairingCode(directory)
    else {
      // The same admission as `pair`: a worktree's own API on its own port.
      const approved = approveExecutorPairingOrigin(value(args, '--api') ?? 'nessie', {
        allowLocalDevelopment: process.env.NESSIE_EXECUTOR_ALLOW_LOCAL_API === '1',
        localDevelopmentOrigin: localDevelopmentApiOrigin(),
      })
      if (!approved.ok) throw new Error(approved.reason)
      const workspace = value(args, '--workspace')
      const operations = value(args, '--operations')
      if (operations !== undefined && args.includes('--pairing-input-stdin')) {
        throw new Error('Choose operations in the pairing input or the command, not both.')
      }
      const input = args.includes('--pairing-input-stdin') ? await stdin() : {
        ...(workspace ? { workspaceRoot: workspace } : {}), replace: args.includes('--replace'),
        ...(operations !== undefined
          ? { operationKeys: operations.split(',').map((entry) => entry.trim()) } : {}),
      }
      const operationKeys = pairingOperationKeys(input.operationKeys)
      const workspaceFolders = await requestedFolders(input)
      view = await startPairingCode({
        apiBaseUrl: approved.origin, operationKeys, replace: input.replace === true,
        stateDir: directory, workspaceFolders,
      })
      if (!json && process.stdin.isTTY) {
        const terminal = createInterface({ input: process.stdin, output: process.stdout })
        try {
          if (view.status === 'alreadyPaired') {
            show(view)
            if ((await terminal.question('Connect it again, replacing that connection? Type yes to continue: '))
              .trim().toLowerCase() !== 'yes') return true
            view = await startPairingCode({
              apiBaseUrl: approved.origin, operationKeys, replace: true, stateDir: directory, workspaceFolders,
            })
          }
          show(view)
          while (view.status === 'waiting') {
            await new Promise((finish) => setTimeout(finish, 3_000))
            view = await pairingCodeStatus(directory)
            const seconds = Math.max(0, Math.ceil((Date.parse(view.expiresAt ?? '') - Date.now()) / 1_000))
            process.stdout.write(`\rCode expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}   `)
          }
          process.stdout.write('\n')
        } finally { terminal.close() }
      }
    }
    if (!explicitDirectory && view.status === 'paired' && view.executorId) {
      await promoteDefaultPairing(directory, view.executorId)
      // Whoever runs this computer's teams takes the new one: the app where
      // it is installed, the command line's own service otherwise.
      if (!json && process.stdin.isTTY && ['login', 'pair', 'pairing-start'].includes(command)) {
        process.stdout.write(`${await startNewTeam({ ...processContext(), platform }, view.executorId)}\n`)
      }
    }
    if (json) process.stdout.write(`${JSON.stringify(view)}\n`)
    else show(view)
    return true
  } catch (error) {
    if (!json || !(error instanceof WorkspaceCleanupRequiredError)) throw error
    process.stdout.write(`${JSON.stringify({ error: { code: 'workspace_cleanup_required' } })}\n`)
    process.exitCode = 1
    return true
  } finally { await rootLease?.release() }
}
