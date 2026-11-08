import { join, resolve } from 'node:path'

import {
  assertExecutorIdentifier, createExecutorServiceEnvironment, executorServiceStateRoot,
  type ExecutorServiceEnvironment, type ExecutorServiceCommandResult,
} from './service-environment.js'
import { serviceAutoRestartEnabled, writeLinuxServiceRestart } from './service-restart.js'

const SERVICE_STATE_DIRECTORY = '.local/state/nessie-executor'
const UNIT_TEMPLATE = 'nessie-executor@'

const requireLinux = (environment: ExecutorServiceEnvironment, command: string): void => {
  if (environment.platform !== 'linux') {
    throw new Error(
      `nessie-computer ${command} controls a systemd user service, so it works only on Linux `
      + `(this computer runs ${environment.platform}).`,
    )
  }
}

const runOrThrow = async (
  environment: ExecutorServiceEnvironment,
  file: string,
  args: string[],
): Promise<ExecutorServiceCommandResult> => {
  const result = await environment.run(file, args)
  if (result.code !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited with status ${result.code}.`)
  }
  return result
}

const unitName = (executorId: string): string => `${UNIT_TEMPLATE}${executorId}.service`

/**
 * The unit template resolves its own state directory from the instance name
 * (`%h/.local/state/nessie-executor/%i`), so enabling an id whose state lives
 * somewhere else would start a service that reads a different directory than
 * the one just verified. `--state-dir` therefore only names the same place by
 * another spelling — a symlinked or bind-mounted state root.
 */
const resolveStateDirectory = (
  environment: ExecutorServiceEnvironment,
  executorId: string,
  requested: string | undefined,
): string => {
  const expected = join(executorServiceStateRoot(environment.home), executorId)
  if (requested === undefined) return expected
  const resolved = resolve(requested)
  if (resolved !== expected) {
    throw new Error(
      `The nessie-executor@${executorId} service reads ~/${SERVICE_STATE_DIRECTORY}/${executorId}. `
      + 'Enabling it against a different state directory would start a different team.',
    )
  }
  return resolved
}

const LINGER_EXPLANATION = [
  'Lingering starts your systemd user manager at boot and keeps it running after you log out.',
  'That keeps this team online when nobody is signed in.',
  'It applies to your whole user account, not only to Nessie, and `loginctl disable-linger` undoes it.',
]

export type EnableExecutorServiceOptions = {
  assumeYes: boolean
  executorId: string
  stateDir?: string
}

export const enableExecutorService = async (
  options: EnableExecutorServiceOptions,
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'enable')
  const executorId = assertExecutorIdentifier(options.executorId)
  const stateDir = resolveStateDirectory(environment, executorId, options.stateDir)
  try {
    await environment.loadPairedState(stateDir)
  } catch (error) {
    // The state loader's own refusals (missing, foreign owner, group-readable,
    // malformed) are the diagnosis; enabling a service for state that cannot be
    // read would produce a unit that fails at every start instead.
    throw new Error(
      `Team ${executorId} has no usable settings in ${stateDir}: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Add this computer to the team first with nessie-computer add.',
    )
  }
  await environment.verifyPackagedRuntime()

  for (const line of LINGER_EXPLANATION) environment.write(line)
  if (!options.assumeYes) {
    if (!environment.interactive) {
      throw new Error(
        'Enabling this team\'s service also enables lingering for your account. '
        + 'Run it again with --yes to accept that without a prompt.',
      )
    }
    if (!await environment.confirm(`Enable lingering for ${environment.username} and start ${unitName(executorId)}?`)) {
      throw new Error('Nothing was changed.')
    }
  }

  // A freshly installed unit template, and this team's restart drop-in, are
  // unknown to an already-running user manager until it reloads.
  await writeLinuxServiceRestart(environment, executorId, await serviceAutoRestartEnabled(stateDir))
  await runOrThrow(environment, 'systemctl', ['--user', 'daemon-reload'])
  await runOrThrow(environment, 'systemctl', ['--user', 'enable', '--now', unitName(executorId)])
  await runOrThrow(environment, 'loginctl', ['enable-linger'])
  environment.write(`Enabled ${unitName(executorId)} and lingering for ${environment.username}.`)
  environment.write(`Logs: journalctl --user -u ${unitName(executorId)}`)
}

export const disableExecutorService = async (
  options: { executorId: string },
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'disable')
  const executorId = assertExecutorIdentifier(options.executorId)
  await runOrThrow(environment, 'systemctl', ['--user', 'disable', '--now', unitName(executorId)])
  environment.write(`Disabled ${unitName(executorId)}.`)
  environment.write('Lingering is unchanged; run `loginctl disable-linger` to stop your user manager at boot.')
}

const unitProperty = async (
  environment: ExecutorServiceEnvironment,
  verb: 'is-active' | 'is-enabled',
  executorId: string,
): Promise<string> => {
  // `is-active` and `is-enabled` answer with a status code as well as a word;
  // "inactive" and "disabled" are exit 3, which is an answer, not a failure.
  const result = await environment.run('systemctl', ['--user', verb, unitName(executorId)])
  return result.stdout.trim().split('\n')[0]?.trim() || 'unknown'
}

/** Stops and disables one team's user unit when it is enabled or running; otherwise does nothing. */
export const disableExecutorServiceIfPresent = async (
  options: { executorId: string },
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  const executorId = assertExecutorIdentifier(options.executorId)
  const enabled = await unitProperty(environment, 'is-enabled', executorId)
  const active = await unitProperty(environment, 'is-active', executorId)
  if (!['enabled', 'enabled-runtime'].includes(enabled) && !['active', 'activating', 'reloading'].includes(active)) return
  await runOrThrow(environment, 'systemctl', ['--user', 'disable', '--now', unitName(executorId)])
}

const lingerState = async (environment: ExecutorServiceEnvironment): Promise<string> => {
  const result = await environment.run('loginctl', ['show-user', environment.username, '-p', 'Linger'])
  if (result.code !== 0) return 'unknown'
  const value = result.stdout.trim().split('=')[1]?.trim()
  return value || 'unknown'
}

export type ExecutorServiceStatusOptions = { executorId?: string; stateRoot?: string }

export const executorServiceStatus = async (
  options: ExecutorServiceStatusOptions,
  environment: ExecutorServiceEnvironment = createExecutorServiceEnvironment(),
): Promise<void> => {
  requireLinux(environment, 'status')
  const stateRoot = options.stateRoot === undefined
    ? executorServiceStateRoot(environment.home)
    : resolve(options.stateRoot)
  const paired = await environment.listStateDirectories(stateRoot)
  const executorIds = options.executorId === undefined
    ? paired
    : [assertExecutorIdentifier(options.executorId)]
  if (options.executorId !== undefined && !paired.includes(options.executorId)) {
    throw new Error(`No team with id ${options.executorId} under ${stateRoot}.`)
  }
  environment.write(`state root: ${stateRoot}`)
  environment.write(`linger: ${await lingerState(environment)}`)
  if (executorIds.length === 0) {
    environment.write('No teams on this computer.')
    return
  }
  for (const executorId of executorIds) {
    const active = await unitProperty(environment, 'is-active', executorId)
    const enabled = await unitProperty(environment, 'is-enabled', executorId)
    const restart = await serviceAutoRestartEnabled(join(stateRoot, executorId)) ? 'on' : 'off'
    environment.write(`team ${executorId}: active=${active} enabled=${enabled} autorestart=${restart}`)
  }
}
