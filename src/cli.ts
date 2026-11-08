/**
 * Nessie Computer's command line. The commands a person types
 * (`cli-user.ts`) come first; the rest are the plumbing verbs the apps and
 * services call: pairing, configuration, the daemon and its local tools.
 * `index.ts` loads this only for them; the built-in servers it starts per
 * session or per agent (`builtin-mcp-cli.ts`) never load the daemon.
 */
import { dirname } from 'node:path'
import { setExistingSessionsEnabled } from './existing-session/settings.js'

import { claimExecutor, heartbeatExecutor } from './daemon.js'
import { setOwnerPaused } from './owner-pause.js'
import { answerProgramRequest, printProgramRequests } from './program-request-cli.js'
import { ProgramRequestError } from './program-requests.js'
import { ExecutorApiError } from './api-client.js'
import { localCommandPolicyOf, type LocalCommandPolicy } from './command-policy.js'
import { serveExecutor } from './daemon-server.js'
import { readAudience } from './audience.js'
import { describeTeam } from './cli-describe.js'
import { teamPaused } from './cli-teams.js'
import { isUserCommand, runUserCli } from './cli-user.js'
import { offerUpdateAtLaunch, runUpdateCli } from './updates/cli.js'
import { runMacServiceCli } from './service-macos.js'
import { runServiceRestartCli } from './service-restart-cli.js'
import { runPairingCodeCli } from './pairing-code-cli.js'
import { runLocalSettingsCli } from './local-settings-cli.js'
import { serveDeepTestSourceAdapter } from './deeptest-source-adapter.js'
import { serveDeepTestExecutionAdapter } from './deeptest-execution-adapter.js'
import { serveDeepTestInferenceAdapter } from './deeptest-inference-adapter.js'
import { loadDeepTestInferenceGrant, publishDeepTestInferenceGrant, revokeDeepTestInferenceGrant,
  type DeepTestInferenceEngine } from './deeptest-inference-grant.js'
import { serveBrowserCookieImportNativeHost } from './browser-cookie-import-native-host.js'
import { connectExecutorLocalInference } from './local-inference-runtime.js'
import { runLocalInferenceCli } from './local-inference-cli.js'
import { readConfigurationInput, type ExecutorConfigurationInput } from './configuration-input.js'
import { serveDirectLocalInference } from './direct-local-inference-runtime.js'
import {
  configureExecutorBrowserSandbox,
  configureExecutorCodexSandbox,
  configureExecutorLocalPolicy,
  pairExecutor,
} from './pair.js'
import { assertPackagedExecutorRuntime } from './runtime-integrity.js'
import {
  disableExecutorService,
  enableExecutorService,
  executorServiceStatus,
} from './service-linux.js'
import { workspaceFoldersFromInput, type ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'
import { parseCommand, UnknownCommandError, type ParsedCommand } from './cli-arguments.js'
import { requestedMcpServers } from './mcp-server-changes.js'
import { runSyncCli } from './folder-sync/sync-cli.js'
import { createFolderSyncTransport } from './folder-sync/transport.js'
import { defaultPairingDirectory } from './pairing-code-directory.js'
import {
  loadExecutorDeepTestSourceGrant,
  loadExecutorDeepTestExecutionGrant,
  loadExecutorState,
  loadExecutorStatesFromRoot,
  publishExecutorDeepTestSourceGrant,
  publishExecutorDeepTestExecutionGrant,
  revokeExecutorDeepTestExecutionGrant,
  type ExecutorLocalState,
} from './state-store.js'

/** The heartbeat a one-shot command sends says what the running daemon's would. */
const ownerPauseReport = async (stateDir: string) => ({
  paused: await teamPaused(stateDir),
  refused: () => { process.stderr.write('This Nessie cannot show that the team is paused; it stays paused here.\n') },
})

/**
 * A proposal that names no built-in programs keeps the ones saved: `trusted`
 * is absent from every proposal made before it existed, and absent must not
 * read as "switch them all off".
 */
const withSavedTrust = (state: ExecutorLocalState, proposed: LocalCommandPolicy | undefined) => {
  const saved = localCommandPolicyOf(state).trusted
  return proposed && proposed.trusted === undefined && saved ? { ...proposed, trusted: saved } : proposed
}

/** A failure of a verb the apps call, under the stable code they key their words on. */
class OwnerVerbFailure extends Error {
  constructor(readonly code: 'EXECUTOR_STATE_UNAVAILABLE' | 'EXECUTOR_NOT_CONNECTED', message: string) {
    super(message)
    this.name = 'OwnerVerbFailure'
  }
}

/** Nessie's own code when Nessie refused; otherwise the verb's; never a guess from the message. */
const failureCode = (error: unknown): string => {
  if (error instanceof OwnerVerbFailure || error instanceof ProgramRequestError) return error.code
  if (error instanceof ExecutorApiError && error.code) return error.code
  return 'EXECUTOR_COMMAND_FAILED'
}

type OwnerVerb = Extract<ParsedCommand, {
  kind: 'pause' | 'resume' | 'program-requests' | 'program-request-answer' | 'audience'
}>

/** The verbs the apps call for one team: pause, resume, program requests and who can send work here. */
const runOwnerVerb = async (command: OwnerVerb, write: (text: string) => void): Promise<void> => {
  const state = await loadExecutorState(command.stateDir).catch((error: unknown) => {
    throw new OwnerVerbFailure('EXECUTOR_STATE_UNAVAILABLE', `This team's saved state could not be read: ${
      error instanceof Error ? error.message : String(error)}`)
  })
  if (command.kind === 'pause' || command.kind === 'resume') {
    const pause = await setOwnerPaused(command.stateDir, command.kind === 'pause')
    write(command.json ? `${JSON.stringify({ paused: pause !== null, ...(pause ? { since: pause.since } : {}) })}\n`
      : pause ? 'Paused. Agents in this team start nothing new on this computer until you resume it.\n'
        : 'Resumed. Agents in this team can use this computer again.\n')
  } else if (command.kind === 'program-requests') {
    await printProgramRequests(command.stateDir, command.json, write)
  } else if (command.kind === 'program-request-answer') {
    await answerProgramRequest(command.stateDir, state, command, write)
  } else {
    if (!state.connectionEpoch) {
      throw new OwnerVerbFailure('EXECUTOR_NOT_CONNECTED', 'This team has not connected yet. Start it, then try again.')
    }
    const audience = await readAudience(command.stateDir)
    const names = (entries: Array<{ name: string }>): string => entries.map((entry) => entry.name).join(', ') || 'none'
    const more = audience.peopleCount - audience.people.length
    write(command.json ? `${JSON.stringify(audience)}\n` : `Agents: ${names(audience.agents)}\n`
      + `People: ${audience.everyoneInTeam ? 'everyone in the team'
        : `${names(audience.people)}${more > 0 ? ` and ${more} more` : ''}`}\n`
      + `Projects: ${names(audience.projects)}\n`)
  }
}

const readPairingChallenge = async (): Promise<string> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 8_192) throw new Error('Pairing challenge is too large.')
    chunks.push(bytes)
  }
  const challenge = Buffer.concat(chunks).toString('utf8').trim()
  if (!challenge) throw new Error('Pairing challenge is required on standard input.')
  return challenge
}

const readPairingInput = async (): Promise<{
  challenge: string
  workspaceFolders: ExecutorWorkspaceFolder[]
}> => {
  const chunks: Buffer[] = []
  let byteLength = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > 12_288) throw new Error('Pairing input is too large.')
    chunks.push(bytes)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Pairing input on standard input is malformed.')
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || typeof (parsed as { challenge?: unknown }).challenge !== 'string'
    || !(parsed as { challenge: string }).challenge
  ) {
    throw new Error('Pairing input on standard input is malformed.')
  }
  return {
    challenge: (parsed as { challenge: string }).challenge,
    workspaceFolders: workspaceFoldersFromInput(parsed, 'Pairing input on standard input'),
  }
}

export const run = async (args: string[]): Promise<void> => {
  if (isUserCommand(args)) {
    offerUpdateAtLaunch(args)
    process.exitCode = await runUserCli(args)
    return
  }
  if (await (await import('./chatgpt-service-attestation.js')).runChatgptServiceAttestation(args)) return
  if (await (await import('./personal-chatgpt-cli.js')).runPersonalChatgptCli(args)) return
  if (await (await import('./chatgpt-credential-runtime.js')).runChatgptCredentialRuntime(args)) return
  if (await runUpdateCli(args)) return
  offerUpdateAtLaunch(args)
  if (await runMacServiceCli(args)) return
  if (await runServiceRestartCli(args)) return
  if (await runLocalInferenceCli(args)) return
  if (await runPairingCodeCli(args)) return
  if (await runLocalSettingsCli(args)) return
  let command: ParsedCommand
  try {
    command = parseCommand(args)
  } catch (error) {
    if (!(error instanceof UnknownCommandError)) throw error
    // No command by that name: the commands people type say so, with a pointer to help.
    process.exitCode = await runUserCli(args)
    return
  }
  if (command.kind === 'pair') {
    const input = command.pairingInputFromStandardInput
      ? await readPairingInput()
      : {
        challenge: command.challenge ?? await readPairingChallenge(),
        workspaceFolders: command.workspaceFolders!,
      }
    const paired = await pairExecutor({
      ...command,
      ...input,
    })
    process.stdout.write(
      `Pairing request submitted. Confirm fingerprint ${paired.fingerprint} in Nessie, then run connect.\n`,
    )
    return
  }
  if (command.kind === 'enable') {
    await enableExecutorService(command)
    return
  }
  if (command.kind === 'disable') {
    await disableExecutorService(command)
    return
  }
  if (command.kind === 'status') {
    await executorServiceStatus(command)
    return
  }
  if (command.kind === 'native-browser-cookie-import') {
    await serveBrowserCookieImportNativeHost({
      callerOrigin: command.callerOrigin,
      expectedExtensionOrigin: command.expectedExtensionOrigin,
      requireDevelopmentLocalApi: command.requireDevelopmentLocalApi,
      states: await loadExecutorStatesFromRoot(command.stateRoot),
    })
    return
  }
  if (command.kind === 'publish-deeptest-source-grant') {
    const grantPath = await publishExecutorDeepTestSourceGrant(command.stateDir)
    process.stdout.write(`${grantPath}\n`)
    return
  }
  if (command.kind === 'publish-deeptest-execution-grant') {
    process.stdout.write(`${await publishExecutorDeepTestExecutionGrant(command.stateDir, { activeTesting: true })}\n`)
    return
  }
  if (command.kind === 'revoke-deeptest-execution-grant') {
    await revokeExecutorDeepTestExecutionGrant(command.stateDir)
    return
  }
  if (command.kind === 'deeptest-source') {
    await assertPackagedExecutorRuntime()
    const grant = await loadExecutorDeepTestSourceGrant(command.sourceGrantFile)
    await serveDeepTestSourceAdapter(
      grant,
      process.stdin,
      process.stdout,
      () => loadExecutorDeepTestSourceGrant(command.sourceGrantFile),
    )
    return
  }
  if (command.kind === 'publish-deeptest-inference-grant') {
    process.stdout.write(`${await publishDeepTestInferenceGrant(command.stateDir, command.engines as DeepTestInferenceEngine[], true,
      { ollamaContextLength: command.ollamaContextLength })}\n`)
    return
  }
  if (command.kind === 'revoke-deeptest-inference-grant') {
    await revokeDeepTestInferenceGrant(command.stateDir)
    return
  }
  if (command.kind === 'deeptest-inference') {
    await assertPackagedExecutorRuntime()
    const grant = await loadDeepTestInferenceGrant(command.inferenceGrantFile)
    await serveDeepTestInferenceAdapter(dirname(command.inferenceGrantFile), grant, process.stdin, process.stdout,
      () => loadDeepTestInferenceGrant(command.inferenceGrantFile))
    return
  }
  if (command.kind === 'deeptest-execution') {
    await assertPackagedExecutorRuntime()
    const grant = await loadExecutorDeepTestExecutionGrant(command.executionGrantFile)
    await serveDeepTestExecutionAdapter(
      dirname(command.executionGrantFile),
      grant,
      process.stdin,
      process.stdout,
      () => loadExecutorDeepTestExecutionGrant(command.executionGrantFile),
    )
    return
  }
  if (command.kind === 'serve-direct-local-inference') {
    await assertPackagedExecutorRuntime()
    await serveDirectLocalInference()
    return
  }
  if (command.kind === 'sync') {
    const stateDir = command.stateDir ?? await defaultPairingDirectory(command.executorId)
    process.exitCode = await runSyncCli(command, {
      stdin: process.stdin, stdout: process.stdout, stateDir, state: await loadExecutorState(stateDir),
      transport: (state) => createFolderSyncTransport(() => state),
    })
    return
  }
  if (command.kind === 'pause' || command.kind === 'resume' || command.kind === 'program-requests'
    || command.kind === 'program-request-answer' || command.kind === 'audience') {
    try {
      await runOwnerVerb(command, (text) => { process.stdout.write(text) })
    } catch (error) {
      if (!command.json) throw error
      process.stdout.write(`${JSON.stringify({ error: {
        code: failureCode(error), message: error instanceof Error ? error.message : String(error),
      } })}\n`)
      process.exitCode = 1
    }
    return
  }
  const state = await loadExecutorState(command.stateDir)
  if (command.kind === 'configure') {
    const input: Partial<ExecutorConfigurationInput> = command.configurationInputFromStandardInput
      ? await readConfigurationInput()
      : {
        commandAllowlist: command.commandAllowlist,
        mcpServers: command.mcpServers,
        operationKeys: command.operationKeys!,
        workspaceFolders: command.workspaceFolders,
      }
    const updated = await configureExecutorLocalPolicy(
      command.stateDir,
      state,
      input.operationKeys!,
      command.nativeHelperPath,
      undefined,
      input.workspaceFolders,
      input.commandAllowlist,
      // Removals by name, and no resent list that would strip a stored server's environment.
      requestedMcpServers(state.mcpServers, input),
      'codingSessions' in input ? { requested: input.codingSessions } : {},
      withSavedTrust(state, input.commandPolicy),
      // Local apps and websites ride on the input; a key it leaves out keeps what is saved.
      input,
    )
    if (input.existingCodingSessionsEnabled !== undefined) {
      await setExistingSessionsEnabled(command.stateDir, input.existingCodingSessionsEnabled)
    }
    // A running team watches its saved state and applies this on its current connection.
    process.stdout.write(
      `Saved as revision ${updated.descriptor.revision}. A running team uses it within a second, `
      + 'and a stopped one when it next starts.\n',
    )
    return
  }
  if (command.kind === 'configure-browser') {
    const updated = await configureExecutorBrowserSandbox(command.stateDir, state, command)
    process.stdout.write(
      `Browser sandbox proposal saved as revision ${updated.descriptor.revision}. `
      + 'Run connect (or restart serve), then have a person review it in Nessie.\n',
    )
    return
  }
  if (command.kind === 'configure-codex') {
    const updated = await configureExecutorCodexSandbox(command.stateDir, state, command)
    process.stdout.write(
      `Codex session policy saved as revision ${updated.descriptor.revision}. Run connect (or restart serve), then have a person review it in Nessie.\n`,
    )
    return
  }
  if (command.kind === 'describe') {
    process.stdout.write(`${JSON.stringify(await describeTeam(command.stateDir, state), undefined, 2)}\n`)
    return
  }
  if (command.kind === 'connect') {
    const live = await claimExecutor(command.stateDir, state)
    // A paused team connects paused: Nessie hears it before it could route anything here.
    if (await teamPaused(command.stateDir)) {
      await heartbeatExecutor(live, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        await ownerPauseReport(command.stateDir))
    }
    await connectExecutorLocalInference(command.stateDir, live)
    process.stdout.write('Executor and local inference daemon connections established.\n')
    return
  }
  if (command.kind === 'heartbeat') {
    await heartbeatExecutor(state, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      await ownerPauseReport(command.stateDir))
    process.stdout.write('Executor heartbeat accepted.\n')
    return
  }
  // A packaged daemon proves its release integrity before it serves anything;
  // outside a package this is a no-op (see runtime-integrity.ts).
  await assertPackagedExecutorRuntime()
  await serveExecutor(command.stateDir, state, {
    ...(command.parentLivenessFromStandardInput ? { parentLiveness: process.stdin } : {}),
  })
}
