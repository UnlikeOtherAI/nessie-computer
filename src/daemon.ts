import { pairedPersonalAuthority } from './personal-authority-origin.js'
import { createHash } from 'node:crypto'

import {
  canonicalExecutorJson,
  executorSessionCommandArgumentProjection,
  ExecutorBrowserActArgumentsSchema,
  ExecutorBrowserObserveArgumentsSchema,
  ExecutorBrowserOpenArgumentsSchema,
  ExecutorConnectedBrowserActArgumentsSchema,
  ExecutorConnectedBrowserObserveArgumentsSchema,
  ExecutorConnectedBrowserOpenArgumentsSchema,
  ExecutorCommandRunArgumentsSchema,
  ExecutorCodingLaunchArgumentsSchema,
  ExecutorCodingObserveArgumentsSchema,
  ExecutorIMessageSendArgumentsSchema,
  ImplementedExecutorOperationKeySchema,
  ExecutorWorkspacePromoteArgumentsSchema,
  RunIdSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { executorApi, type ExecutorApiClient } from './api-client.js'
import { CODING_SESSION_COMMAND_RULES_META } from './coding-session/meta-keys.js'
import type { LocalCommandPolicy } from './command-policy.js'
import { admitCommandRun, admitTerminalLaunch, type ProgramAdmission } from './daemon-program-admission.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorBrowserSessionManager } from './browser-session-manager.js'
import type { ExecutorConnectedBrowserSessionManager } from './connected-browser-session-manager.js'
import type { ExecutorCodingSessionManager } from './coding-session-manager.js'
import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import type { ExecutorCommandSessionManager } from './command-session-manager.js'
import type { IMessageBridge } from './imessage/imessage-bridge.js'
import {
  executorAttachmentUploadTimeoutMs,
  type ExecutorAttachmentUpload,
  type ExecutorCommandAttachmentStore,
} from './command-attachments.js'
import { executeExecutorMcpCommand } from './mcp-dispatch.js'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'
import { applyNativePromotion } from './native-helper.js'
import {
  stopSandboxWorkspace,
  reviewSandboxWorkspace,
  promotionManifestForSandbox,
  workspaceViewForRun,
  writeSandboxFile,
} from './sandbox-workspace.js'
import type { ExecutorLocalState } from './state-store.js'
import { executorWorkspaceFolderNames } from './workspace-folders.js'
import { listWorkspaceFiles, readWorkspaceFile, workspaceFailure } from './workspace.js'

export { claimExecutor, heartbeatExecutor } from './daemon-connection.js'


const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalExecutorJson(value)).digest('hex')}`

export const sendExecutorCommandReceipt = async (
  state: ExecutorLocalState,
  input: {
    commandId: ExecutorCommandEnvelope['commandId']
    result?: Record<string, unknown>
    state: 'accepted' | 'started' | 'result_acknowledged'
  },
): Promise<void> => {
  if (!state.connectionEpoch) throw new Error('This team is not connected from this computer right now.')
  const occurredAt = new Date().toISOString()
  const commandReceipt = {
    commandId: input.commandId,
    occurredAt,
    ...(input.result ? { resultDigest: digest(input.result) } : {}),
    state: input.state,
  }
  const payload = {
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
    receipt: commandReceipt,
  }
  await executorApi.recordCommandReceipt(state.apiBaseUrl, {
    ...payload,
    ...(input.result ? { result: input.result } : {}),
    signature: signExecutorDaemonPayload(state.machinePrivateKey, 'receipt', payload),
  })
}

/**
 * One image of a result, under its own signed `attachment` domain. The
 * signature covers the digest, not the bytes: the control plane recomputes the
 * digest from the bytes it receives.
 */
export const uploadExecutorCommandAttachment = (
  state: ExecutorLocalState,
  api: Pick<ExecutorApiClient, 'uploadCommandAttachment'> = executorApi,
): ExecutorAttachmentUpload => async (image) => {
  if (!state.connectionEpoch) throw new Error('This team is not connected from this computer right now.')
  const payload = {
    attachment: {
      byteLength: image.bytes.length,
      commandId: image.commandId,
      digest: image.digest,
      mimeType: image.mimeType,
      occurredAt: new Date().toISOString(),
    },
    connectionEpoch: state.connectionEpoch,
    executorId: state.executorId,
  }
  await api.uploadCommandAttachment(state.apiBaseUrl, {
    ...payload,
    dataBase64: image.bytes.toString('base64'),
    signature: signExecutorDaemonPayload(state.machinePrivateKey, 'attachment', payload),
  }, { timeoutMs: executorAttachmentUploadTimeoutMs(image.bytes.length) })
}

/**
 * The bridge's stamp for one call, with the rules a launch the owner allowed
 * once runs under in place of the saved ones: only this call carries them.
 */
const withLaunchRules = (
  bridge: Pick<CodingSessionsDaemon, 'callMeta'> | undefined, rules: LocalCommandPolicy,
): Pick<CodingSessionsDaemon, 'callMeta'> | undefined => bridge && {
  callMeta: (server, call) => {
    const meta = bridge.callMeta(server, call)
    return meta && { ...meta, [CODING_SESSION_COMMAND_RULES_META]: rules }
  },
}

/**
 * A guest VM mounts one workspace. Until the guest protocol in
 * `executor/guest/*.go` can bind several, an executor that exposes more than one
 * folder refuses to start a guest session here — at the dispatch a person reads
 * when they ask why a run was refused — rather than silently binding to the
 * first folder and letting them believe an agent inside that VM can see the
 * rest. The file operations are unaffected: they reach every folder.
 */
const guestSessionRefusal = (state: ExecutorLocalState): Record<string, unknown> | null =>
  state.workspaceFolders.length === 1
    ? null
    : {
      code: 'EXECUTOR_GUEST_SINGLE_FOLDER_REQUIRED',
      folders: executorWorkspaceFolderNames(state.workspaceFolders),
      message:
        'A guest session mounts one folder, and this team uses '
        + `${state.workspaceFolders.length}. The workspace file operations reach every folder.`,
      success: false,
    }

export const executeExecutorCommand = async (
  stateDir: string,
  state: ExecutorLocalState,
  command: ExecutorCommandEnvelope,
  dependencies: {
    /** Where an `mcp.call`'s images are kept until they are delivered. */
    attachments?: Pick<ExecutorCommandAttachmentStore, 'write'>
    browserSessions?: ExecutorBrowserSessionManager
    connectedBrowserSessions?: ExecutorConnectedBrowserSessionManager
    commandSessions?: ExecutorCommandSessionManager
    codingSessions?: ExecutorCodingSessionManager
    mcpSessions?: ExecutorMcpSessionManager
    /** Stamps who a call to the built-in coding-sessions bridge is for. */
    codingBridge?: Pick<CodingSessionsDaemon, 'callMeta'>
    /** The owner paused this team on this computer (`owner-pause.ts`). */
    ownerPaused?: () => boolean
    /** iMessage on a Mac (`imessage/imessage-bridge.ts`). */
    imessage?: Pick<IMessageBridge, 'send'>
    /** Asks the owner about a launch refused only as not allowed; absent, it is refused as before. */
    programRequests?: ProgramAdmission
    signal?: AbortSignal
  } = {},
): Promise<Record<string, unknown>> => {
  dependencies.signal?.throwIfAborted()
  if (!ImplementedExecutorOperationKeySchema.safeParse(command.operationKey).success) {
    return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
  }
  // Paused, the team starts nothing new; what already runs finishes, and a
  // stop, which only ends work, still ends it.
  if (dependencies.ownerPaused?.() && command.operationKey !== 'sandbox.stop') {
    return {
      code: 'EXECUTOR_OWNER_PAUSED',
      message: 'The computer\'s owner paused this team on the computer. Nothing new starts until they resume it.',
      success: false,
    }
  }
  if (new Date(command.expiresAt) <= new Date()) {
    return { code: 'EXECUTOR_COMMAND_EXPIRED', success: false }
  }
  if (command.capabilityRevision !== state.descriptor.revision) {
    return { code: 'EXECUTOR_DESCRIPTOR_STALE', success: false }
  }
  if (!state.descriptor.operationKeys.includes(command.operationKey)) {
    return { code: 'EXECUTOR_LOCAL_POLICY_DENIED', success: false }
  }
  if (digest(executorSessionCommandArgumentProjection(command.payload)) !== command.argumentDigest) {
    return { code: 'EXECUTOR_COMMAND_DIGEST_INVALID', success: false }
  }
  try { pairedPersonalAuthority(command.payload.personalAuthority, state.apiBaseUrl) }
  catch { return { code: 'EXECUTOR_PERSONAL_AUTHORITY_INVALID', success: false } }
  const runId = RunIdSchema.safeParse(command.payload.runId)
  if (!runId.success) {
    return { code: 'EXECUTOR_COMMAND_RUN_INVALID', success: false }
  }
  if (command.operationKey === 'file.list') {
    try {
      return await listWorkspaceFiles(
        workspaceViewForRun(stateDir, state.workspaceFolders, runId.data),
        command.payload.args,
      )
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'file.read') {
    try {
      return await readWorkspaceFile(
        workspaceViewForRun(stateDir, state.workspaceFolders, runId.data),
        command.payload.args,
      )
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'file.write') {
    try {
      return await writeSandboxFile(stateDir, state.workspaceFolders, runId.data, command.payload.args)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'workspace.review') {
    try {
      return await reviewSandboxWorkspace(stateDir, runId.data)
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'workspace.promote') {
    try {
      const args = ExecutorWorkspacePromoteArgumentsSchema.parse(command.payload.args)
      const manifest = await promotionManifestForSandbox(stateDir, runId.data)
      if (manifest.manifestDigest !== args.manifestDigest) {
        return { code: 'EXECUTOR_PROMOTION_REVIEW_STALE', success: false }
      }
      // The native helper writes one reviewed draft into one host directory it
      // holds as a descriptor, and recomputes the manifest digest itself. A
      // run that drafted several folders needs several of those write
      // protocols, which is a change to that separately packaged binary — so it
      // is refused here, named, rather than promoting one folder and reporting
      // success for a review that covered more.
      const [only] = manifest.folders
      if (!only || manifest.folders.length !== 1) {
        return {
          code: 'EXECUTOR_PROMOTION_SINGLE_FOLDER_REQUIRED',
          folders: manifest.folders.map((folder) => folder.name),
          message: manifest.folders.length === 0
            ? 'This run has no workspace folder draft to promote.'
            : 'This review changed more than one workspace folder, and promotion applies one.',
          success: false,
        }
      }
      const folder = state.workspaceFolders.find((candidate) => candidate.name === only.name)
      if (!folder) return { code: 'EXECUTOR_PROMOTION_FOLDER_UNKNOWN', success: false }
      return await applyNativePromotion({
        signal: dependencies.signal,
        approvedManifestDigest: manifest.manifestDigest,
        draftWorkspace: only.workspace,
        helperPath: state.nativeHelperPath,
        request: {
          approvalDigest: args.approvalDigest,
          bindingFence: command.bindingFence,
          changes: only.changes,
          manifestDigest: only.manifestDigest,
          promotionId: args.promotionId,
          protocolVersion: only.protocolVersion,
          runId: only.runId,
        },
        workspaceRoot: folder.path,
      })
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'browser.open') {
    if (!ExecutorBrowserOpenArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    const refusal = guestSessionRefusal(state)
    if (refusal) return refusal
    return dependencies.browserSessions
      ? dependencies.browserSessions.open(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.observe') {
    if (!ExecutorBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    return dependencies.browserSessions
      ? dependencies.browserSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.act') {
    if (!ExecutorBrowserActArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_BROWSER_DENIED', success: false }
    }
    return dependencies.browserSessions
      ? dependencies.browserSessions.act(command, runId.data)
      : { code: 'EXECUTOR_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.open') {
    if (!ExecutorConnectedBrowserOpenArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.open(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.observe') {
    if (!ExecutorConnectedBrowserObserveArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'browser.connected.act') {
    if (!ExecutorConnectedBrowserActArgumentsSchema.safeParse(command.payload.args).success) return { code: 'EXECUTOR_CONNECTED_BROWSER_DENIED', success: false }
    return dependencies.connectedBrowserSessions
      ? dependencies.connectedBrowserSessions.act(command, runId.data)
      : { code: 'EXECUTOR_CONNECTED_BROWSER_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'command.run') {
    const commandArguments = ExecutorCommandRunArgumentsSchema.safeParse(command.payload.args)
    if (!commandArguments.success) {
      return { code: 'EXECUTOR_COMMAND_DENIED', success: false }
    }
    const { commandSessions } = dependencies
    const unavailable = (): Record<string, unknown> | null => guestSessionRefusal(state)
      ?? (commandSessions ? null : { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false })
    // Refused here as well as in the session manager, against the same
    // predicate: this is the dispatch a person reads when they ask why a run
    // was refused, and it must not depend on a session backend being wired.
    // The owner is asked only about a launch that could then actually run.
    const admitted = await admitCommandRun(dependencies.programRequests, state, command,
      commandArguments.data.program, commandArguments.data.args, unavailable, dependencies.signal)
    if ('refusal' in admitted) return admitted.refusal
    const refusal = unavailable()
    if (refusal || !commandSessions) return refusal ?? { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false }
    return commandSessions.run(command, runId.data, admitted.rules)
  }
  if (command.operationKey === 'coding.launch') {
    if (!ExecutorCodingLaunchArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_CODING_DENIED', success: false }
    }
    const refusal = guestSessionRefusal(state)
    if (refusal) return refusal
    return dependencies.codingSessions
      ? dependencies.codingSessions.launch(command, runId.data)
      : { code: 'EXECUTOR_CODING_UNAVAILABLE', success: false }
  }
  if (command.operationKey === 'coding.observe') {
    if (!ExecutorCodingObserveArgumentsSchema.safeParse(command.payload.args).success) {
      return { code: 'EXECUTOR_CODING_DENIED', success: false }
    }
    return dependencies.codingSessions
      ? dependencies.codingSessions.observe(command, runId.data)
      : { code: 'EXECUTOR_CODING_UNAVAILABLE', success: false }
  }
  // Stop can discard only its exact server-provenanced run scratch directory.
  if (command.operationKey === 'sandbox.stop') {
    try {
      await dependencies.browserSessions?.stop(runId.data)
      await dependencies.connectedBrowserSessions?.stop(runId.data)
      await dependencies.commandSessions?.stop(runId.data)
      await dependencies.codingSessions?.stop(runId.data)
      return {
        status: await stopSandboxWorkspace(stateDir, runId.data) ? 'stopped' : 'no_active_sandbox',
        success: true,
      }
    } catch (error) {
      return workspaceFailure(error)
    }
  }
  if (command.operationKey === 'mcp.tools' || command.operationKey === 'mcp.call') {
    const { attachments, mcpSessions } = dependencies
    const operationKey = command.operationKey
    const admitted = operationKey === 'mcp.call' && mcpSessions
      ? await admitTerminalLaunch(dependencies.programRequests, state, command, dependencies.signal)
      : undefined
    if (admitted && 'refusal' in admitted) return admitted.refusal
    return executeExecutorMcpCommand(operationKey, command.payload.args, mcpSessions, {
      codingBridge: admitted?.rules
        ? withLaunchRules(dependencies.codingBridge, admitted.rules) : dependencies.codingBridge,
      commandId: command.commandId,
      payload: command.payload,
    }, attachments && ((images) => attachments.write(command.commandId, images)), dependencies.signal)
  }
  if (command.operationKey === 'imessage.send') {
    const args = ExecutorIMessageSendArgumentsSchema.safeParse(command.payload.args)
    if (!args.success) return { code: 'IMESSAGE_SEND_FAILED', message: args.error.issues[0]?.message, success: false }
    if (!dependencies.imessage) return { code: 'IMESSAGE_OFF', message: 'iMessage is only on a Mac.', success: false }
    const outcome = await dependencies.imessage.send(args.data)
    return outcome.ok ? { ...outcome.result, success: true }
      : { code: outcome.code, message: outcome.message, success: false }
  }
  // Other declared-only operations remain unavailable.
  return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
}
