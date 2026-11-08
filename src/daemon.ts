import { pairedPersonalAuthority } from './personal-authority-origin.js'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

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
  ImplementedExecutorOperationKeySchema,
  ExecutorWorkspacePromoteArgumentsSchema,
  RunIdSchema,
  type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import { executorApi, type ExecutorApiClient } from './api-client.js'
import { executeWithCommandCancellation } from './command-cancellation.js'
import { localCommandPolicyPermits } from './command-policy.js'
import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorBrowserSessionManager } from './browser-session-manager.js'
import type { ExecutorConnectedBrowserSessionManager } from './connected-browser-session-manager.js'
import type { ExecutorCodingSessionManager } from './coding-session-manager.js'
import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import type { ExecutorCommandSessionManager } from './command-session-manager.js'
import {
  createExecutorCommandAttachmentStore,
  deliverExecutorCommandAttachments,
  executorAttachmentUploadTimeoutMs,
  type ExecutorAttachmentUpload,
  type ExecutorCommandAttachmentStore,
} from './command-attachments.js'
import {
  createExecutorCommandRecoveryStore,
  recoverOrPollExecutorCommand,
  type ExecutorCommandRecoveryStore,
} from './command-recovery.js'
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

const receipt = async (
  state: ExecutorLocalState,
  input: {
    commandId: ExecutorCommandEnvelope['commandId']
    result?: Record<string, unknown>
    state: 'accepted' | 'started' | 'result_acknowledged'
  },
): Promise<void> => {
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
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
  if (!state.connectionEpoch) throw new Error('Executor has not claimed a live daemon connection.')
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
        'A guest session mounts one workspace folder, and this executor exposes '
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
    signal?: AbortSignal
  } = {},
): Promise<Record<string, unknown>> => {
  dependencies.signal?.throwIfAborted()
  if (!ImplementedExecutorOperationKeySchema.safeParse(command.operationKey).success) {
    return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
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
    // Refused here as well as in the session manager, against the same
    // predicate: this is the dispatch a person reads when they ask why a run
    // was refused, and it must not depend on a session backend being wired.
    if (!localCommandPolicyPermits(
      state,
      commandArguments.data.program,
      commandArguments.data.args,
    )) {
      return { code: 'EXECUTOR_COMMAND_DENIED', success: false }
    }
    const refusal = guestSessionRefusal(state)
    if (refusal) return refusal
    return dependencies.commandSessions
      ? dependencies.commandSessions.run(command, runId.data)
      : { code: 'EXECUTOR_COMMAND_UNAVAILABLE', success: false }
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
    const { attachments } = dependencies
    return executeExecutorMcpCommand(command.operationKey, command.payload.args, dependencies.mcpSessions, {
      codingBridge: dependencies.codingBridge,
      commandId: command.commandId,
      payload: command.payload,
    }, attachments && ((images) => attachments.write(command.commandId, images)), dependencies.signal)
  }
  // Other declared-only operations remain unavailable.
  return { code: 'EXECUTOR_BACKEND_UNAVAILABLE', success: false }
}

/**
 * `store` is owned by the caller and lives as long as the daemon does. It used
 * to be built here, once per poll, which rebuilt the owner-only proof of the
 * runtime directory every second — two native-helper process spawns per poll on
 * Windows. The journal it fronts is per-`stateDir` state, and `stateDir` does
 * not change across a daemon's life, so one store is the honest lifetime. The
 * sidecar store beside it is the caller's for the same reason.
 */
export const pollAndExecuteCommand = async (
  stateDir: string,
  state: ExecutorLocalState,
  browserSessions: ExecutorBrowserSessionManager,
  commandSessions: ExecutorCommandSessionManager,
  codingSessions: ExecutorCodingSessionManager,
  mcpSessions: ExecutorMcpSessionManager,
  store: ExecutorCommandRecoveryStore = createExecutorCommandRecoveryStore(stateDir),
  codingBridge?: Pick<CodingSessionsDaemon, 'callMeta'>,
  sidecars: ExecutorCommandAttachmentStore = createExecutorCommandAttachmentStore(stateDir),
): Promise<void> => {
  const connectionEpoch = state.connectionEpoch
  if (!connectionEpoch) return
  await recoverOrPollExecutorCommand({
    attachments: {
      deliver: ({ command, delivered, journal, result }) => deliverExecutorCommandAttachments({
        command,
        delivered,
        journal,
        // The reason names only Nessie's own refusal; the image stays here.
        onWithdrawn: (reference, reason) => {
          console.error(
            `[nessie-executor] image ${reference.attachmentDigest} of command ${command.commandId} `
            + `was not delivered: ${reason}`,
          )
        },
        result,
        sidecars,
        upload: uploadExecutorCommandAttachment(state),
      }),
      release: (commandId) => sidecars.remove(commandId),
    },
    execute: (command) => executeWithCommandCancellation({
      command,
      state,
      cancel: async () => {
        const runId = RunIdSchema.parse(command.payload.runId)
        // Tear down only the backend this command owns; other sessions on the
        // computer keep their own lifetimes. VM teardown ends every guest process.
        if (command.operationKey.startsWith('browser.')) await browserSessions.stop(runId)
        if (command.operationKey === 'command.run') await commandSessions.stop(runId)
        if (command.operationKey.startsWith('coding.')) await codingSessions.stop(runId)
      },
      execute: (signal) => executeExecutorCommand(stateDir, state, command, {
        attachments: sidecars, browserSessions, codingSessions, mcpSessions, commandSessions,
        signal, ...(codingBridge ? { codingBridge } : {}),
      }),
    }),
    // The result itself stays on this machine: it can quote program output.
    onResultRefused: (command) => {
      console.error(
        `[nessie-executor] Nessie refused the result of ${command.operationKey} command ${command.commandId}; `
        + 'it was reported as EXECUTOR_RESULT_REFUSED instead.',
      )
    },
    store,
    transport: {
      poll: async () => {
        const observedAt = new Date().toISOString()
        const payload = {
          connectionEpoch,
          executorId: state.executorId,
          observedAt,
        }
        const response = await executorApi.pollCommand(state.apiBaseUrl, {
          ...payload,
          signature: signExecutorDaemonPayload(state.machinePrivateKey, 'poll', payload),
        })
        return response.command
      },
      receipt: (input) => receipt(state, input),
    },
  })
}

export const waitForExecutorDaemonShutdown = async (
  parentLiveness?: Readable,
  updateReady?: Promise<void>,
): Promise<void> => new Promise((resolve) => {
  const stop = () => {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    parentLiveness?.off('close', stop)
    parentLiveness?.off('end', stop)
    parentLiveness?.off('error', stop)
    // A signal stops the daemon while its parent still holds the pipe, and a
    // resumed pipe left open keeps this process alive after its shutdown.
    parentLiveness?.destroy()
    resolve()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  void updateReady?.then(stop)
  if (parentLiveness) {
    parentLiveness.once('close', stop)
    parentLiveness.once('end', stop)
    parentLiveness.once('error', stop)
    parentLiveness.resume()
  }
})

export const createNonOverlappingExecutorTask = (
  task: () => Promise<void>,
): { current: () => Promise<void> | null; run: () => Promise<void> } => {
  let current: Promise<void> | null = null
  return {
    current: () => current,
    run: () => {
      if (current) return current
      const started = task().finally(() => {
        if (current === started) current = null
      })
      current = started
      return started
    },
  }
}
