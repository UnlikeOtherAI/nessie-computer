/**
 * The executor's commands: pairing, configuration, the daemon and its local
 * tools. `index.ts` loads this only for them; the built-in servers it starts
 * per session or per agent (`builtin-mcp-cli.ts`) never load the daemon.
 */
import { existingClaudeChannelConfiguration } from './existing-session/setup.js'
import { dirname } from 'node:path'
import { existingSessionsEnabled, setExistingSessionsEnabled } from './existing-session/settings.js'

import { claimExecutor, heartbeatExecutor } from './daemon.js'
import { readOwnerPause, setOwnerPaused } from './owner-pause.js'
import { answerProgramRequest, printProgramRequests } from './program-request-cli.js'
import { listProgramRequests } from './program-requests.js'
import { serveExecutor } from './daemon-server.js'
import { readAudience } from './audience.js'
import { describeExecutorWithLocalApps } from './describe.js'
import { runDistributionCli } from './distribution-cli.js'
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
import { parseCommand } from './cli-arguments.js'
import { describeFolderSync } from './folder-sync/console-state.js'
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
} from './state-store.js'

/** A pause file that cannot be read counts as paused, as it does in the daemon. */
const ownerPaused = async (stateDir: string): Promise<boolean> =>
  (await readOwnerPause(stateDir).catch(() => ({ paused: true }))) !== null

/** The heartbeat a one-shot command sends says what the running daemon's would. */
const ownerPauseReport = async (stateDir: string) => ({
  paused: await ownerPaused(stateDir),
  refused: () => { process.stderr.write('This Nessie cannot show that the team is paused; it stays paused here.\n') },
})

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
  if (await (await import('./chatgpt-service-attestation.js')).runChatgptServiceAttestation(args)) return
  if (await (await import('./personal-chatgpt-cli.js')).runPersonalChatgptCli(args)) return
  if (await (await import('./chatgpt-credential-runtime.js')).runChatgptCredentialRuntime(args)) return
  if (runDistributionCli(args) || await runUpdateCli(args)) return
  offerUpdateAtLaunch(args)
  if (await runMacServiceCli(args)) return
  if (await runServiceRestartCli(args)) return
  if (await runLocalInferenceCli(args)) return
  if (await runPairingCodeCli(args)) return
  if (await runLocalSettingsCli(args)) return
  const command = parseCommand(args)
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
      input.mcpServers,
      'codingSessions' in input ? { requested: input.codingSessions } : {},
      input.commandPolicy,
      {
        ...(input.mcpPolicy === undefined ? {} : { mcpPolicy: input.mcpPolicy }),
        ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
      },
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
  if (command.kind === 'pause' || command.kind === 'resume') {
    const pause = await setOwnerPaused(command.stateDir, command.kind === 'pause')
    process.stdout.write(command.json ? `${JSON.stringify({ paused: pause !== null,
      ...(pause ? { since: pause.since } : {}) })}\n`
      : pause ? 'Paused. Agents in this team start nothing new on this computer until you resume it.\n'
        : 'Resumed. Agents in this team can use this computer again.\n')
    return
  }
  if (command.kind === 'audience') {
    const audience = await readAudience(command.stateDir)
    if (command.json) {
      process.stdout.write(`${JSON.stringify(audience)}\n`)
      return
    }
    const names = (entries: Array<{ name: string }>): string => entries.map((entry) => entry.name).join(', ') || 'none'
    process.stdout.write(`Agents: ${names(audience.agents)}\n`
      + `People: ${audience.everyoneInTeam ? 'everyone in the team' : `${names(audience.people)}${
        audience.peopleCount > audience.people.length ? ` and ${audience.peopleCount - audience.people.length} more` : ''}`}\n`
      + `Projects: ${names(audience.projects)}\n`)
    return
  }
  if (command.kind === 'program-requests') {
    await printProgramRequests(command.stateDir, command.json, (text) => { process.stdout.write(text) })
    return
  }
  if (command.kind === 'program-request-answer') {
    await answerProgramRequest(command.stateDir, state, command, (text) => { process.stdout.write(text) })
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
    process.stdout.write(`${JSON.stringify({ ...await describeExecutorWithLocalApps(state),
      paused: await ownerPaused(command.stateDir),
      pendingProgramRequests: (await listProgramRequests(command.stateDir)).length,
      folderSync: await describeFolderSync(command.stateDir, state.executorId),
      existingCodingSessionsEnabled: await existingSessionsEnabled(command.stateDir),
      existingClaudeChannelConfiguration: existingClaudeChannelConfiguration(state, command.stateDir) }, undefined, 2)}\n`)
    return
  }
  if (command.kind === 'connect') {
    const live = await claimExecutor(command.stateDir, state)
    // A paused team connects paused: Nessie hears it before it could route anything here.
    if (await ownerPaused(command.stateDir)) {
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
