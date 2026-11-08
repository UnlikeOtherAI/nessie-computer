import type { Readable, Writable } from 'node:stream'
import { createRetainedDaemonRuntime } from './t3-session/runtime/daemon-handoff.js'
import { attachRetainedParentHandoff } from './t3-session/runtime/parent-handoff.js'
import { registerMachineT3Sources } from './t3-session/source/owner.js'
import { enableLocalSessionBridge } from './local-session-bridge.js'
import { withBridgeOnRuntime, type ExecutorRuntime } from './coding-sessions-policy.js'
import { createSessionAuthorityClient } from './session-authority-client.js'

import { executorApi } from './api-client.js'
import { createExecutorBrowserSessionManager } from './browser-session-manager.js'
import { createExecutorCodingSessionManager } from './coding-session-manager.js'
import { createCodingSessionsDaemon, withDaemonSupervisor } from './coding-sessions-daemon.js'
import { localCommandPolicyOf } from './command-policy.js'
import { createExecutorCommandSessionManager } from './command-session-manager.js'
import {
  claimExecutor,
  createNonOverlappingExecutorTask,
  heartbeatExecutor,
  pollAndExecuteCommand,
  waitForExecutorDaemonShutdown,
} from './daemon.js'
import {
  commandPollFailureStopsSessions,
  createExecutorCommandAttachmentStore,
  sweepExecutorCommandAttachments,
} from './command-attachments.js'
import { createExecutorCommandRecoveryStore } from './command-recovery.js'
import { FolderSyncEngine } from './folder-sync/engine.js'
import { startFolderSyncLoop } from './folder-sync/engine-loop.js'
import { createFolderSyncTransport } from './folder-sync/transport.js'
import { acquireExecutorDaemonLease } from './daemon-lease.js'
import { stopKelpieDescribes } from './kelpie-detect.js'
import { createLocalMcpReporter } from './local-mcp-report.js'
import { startExecutorLocalInferenceSupervisor } from './local-inference-supervisor.js'
import { createExecutorMcpSessionManager } from './mcp-session-manager.js'
import type { ExecutorLocalState } from './state-store.js'
import { createSessionViewRelay } from './session-view-relay.js'
import { createT3SessionLane } from './t3-session-lane.js'
import { createDaemonCadence } from './daemon-cadence.js'
import { ExecutorDaemonDoorbell } from './daemon-doorbell.js'
import { createOwnerRequestsGate, reportForServer } from './owner-requests-gate.js'
import { watchSessionChanges } from './session-change-watch.js'
import { startComputerMonitor } from './computer-monitor.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { reportedSoftwareStatus, requestSoftwareUpdate } from './updates/native-client.js'

// A shutdown that opted in to closing coding sessions gets this long to ask the bridge.
const CODING_SESSION_SHUTDOWN_BUDGET_MS = 5_000
// How often the Codex threads found open on this computer are asked whether they wait on their own client.
const EXISTING_STATUS_REFRESH_MS = 5_000

const withinShutdownBudget = (work: Promise<void>): Promise<void> => Promise.race([
  work.catch(() => undefined),
  new Promise<void>((settle) => { setTimeout(settle, CODING_SESSION_SHUTDOWN_BUDGET_MS).unref() }),
])

/** Runs the paired executor and its sibling local Ollama host under one lease. */
export const serveExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
  options: { parentLiveness?: Readable; retainedParentOutput?: Writable; runtime?: ExecutorRuntime } = {},
): Promise<void> => {
  const daemonLease = await acquireExecutorDaemonLease(stateDir)
  let protectionRuntime: Awaited<ReturnType<PersonalInferenceGuard['registerRuntime']>> | null = null
  let releaseT3Sources: (() => void) | undefined
  let retained: ReturnType<typeof createRetainedDaemonRuntime> | undefined
  let retainedParent: ReturnType<typeof attachRetainedParentHandoff> | undefined
  let retainedFailure: unknown
  const closeRetained = async () => {
    try { await retained?.close() } catch (error) { retainedFailure ??= error }
    try { await retainedParent?.close() } catch (error) { retainedFailure ??= error }
  }
  try {
    if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
      protectionRuntime = await PersonalInferenceGuard.open().registerRuntime(`executor:${state.executorId}`)
    }
    let live = await claimExecutor(stateDir, await enableLocalSessionBridge(stateDir, state, options.runtime))
    const localInference = await startExecutorLocalInferenceSupervisor(stateDir, live)
    live = localInference.state
    releaseT3Sources = registerMachineT3Sources(stateDir, live.executorId)
    let wakeRetained = () => undefined as void
    const retainedRuntime = createRetainedDaemonRuntime(stateDir, () => live, () => wakeRetained(),
      status => retainedParent?.report(status))
    retained = retainedRuntime
    if (options.retainedParentOutput) {
      if (!options.parentLiveness) throw new Error('retained_handoff_parent_required')
      retainedParent = attachRetainedParentHandoff(options.parentLiveness, options.retainedParentOutput,
        retainedRuntime.accept, retainedRuntime.close)
    }
    const browserSessions = createExecutorBrowserSessionManager(stateDir, live)
    const commandSessions = createExecutorCommandSessionManager(stateDir, live)
    const codingSessions = createExecutorCodingSessionManager(stateDir, live)
    const namedMcpServers = withDaemonSupervisor(withBridgeOnRuntime(live.mcpServers ?? [], options.runtime))
    const mcpSessions = createExecutorMcpSessionManager(namedMcpServers, live.descriptor.limits)
    // Whether this connection's Nessie reads what sessions wait on their owner for: its doorbell said ready.
    const ownerRequestsGate = createOwnerRequestsGate(() => live.connectionEpoch)
    // Coding sessions outlive runs and daemon restarts, so the daemon ends
    // them itself wherever it ends its other sessions.
    const codingBridge = createCodingSessionsDaemon({
      pairingSource: () => live.sessionPairingSource,
      validateSessionAuthority: createSessionAuthorityClient(() => live),
      connectionEpoch: () => live.connectionEpoch,
      executorId: live.executorId,
      commandRules: localCommandPolicyOf(live),
      facts: live.descriptor.codingSessions,
      servers: namedMcpServers,
      sessions: mcpSessions,
      serverReadsRequests: ownerRequestsGate.understood,
    })
    const localMcp = createLocalMcpReporter(namedMcpServers, mcpSessions, { codingSessions: codingBridge.report })
    const monitor = startComputerMonitor(stateDir)
    const relayScreens = createSessionViewRelay(
      codingBridge, ownerRequestsGate.understood, ownerRequestsGate.holdReports,
    )
    const t3Lane = createT3SessionLane(retainedRuntime.lane)
    const screenPoll = createNonOverlappingExecutorTask(async () => {
      await Promise.allSettled([relayScreens(live), t3Lane.exchangeT3SessionOperations(live)])
    })
    void localMcp.refresh().catch(() => undefined)
    let shuttingDown = false
    let drainingForUpdate = false
    let finishUpdateDrain: () => void = () => undefined
    const updateReady = new Promise<void>((resolve) => { finishUpdateDrain = resolve })
    // One store for the daemon's whole life. Building it per poll re-secured
    // the runtime directory every second, which on Windows is two native-helper
    // process spawns a second and nothing at all on POSIX.
    const recoveryStore = createExecutorCommandRecoveryStore(stateDir)
    const attachmentStore = createExecutorCommandAttachmentStore(stateDir)
    // Before the first poll, so no folder a new command writes can be swept.
    await sweepExecutorCommandAttachments(recoveryStore, attachmentStore).catch((error: unknown) => {
      console.error('[nessie-executor] attachment sweep failed:', error instanceof Error ? error.message : String(error))
    })
    const commandPoll = createNonOverlappingExecutorTask(() => pollAndExecuteCommand(
      stateDir, live, browserSessions, commandSessions, codingSessions, mcpSessions, recoveryStore, codingBridge,
      attachmentStore,
    ).catch(async (error) => {
      // An image upload the next poll makes again says nothing about the
      // connection or the other sessions; stopping them for it ended a
      // person's browser and coding sessions over one slow answer from Nessie.
      if (commandPollFailureStopsSessions(error)) {
        await browserSessions.stopAll()
        await commandSessions.stopAll()
        await codingSessions.stopAll()
        // Host coding sessions outlive a failed poll; only a definitive or lasting failure closes them.
        await codingBridge.connectionFailed('command_poll_failed', error).catch(() => undefined)
      }
      console.error('[nessie-executor] command poll failed:', error instanceof Error ? error.message : String(error))
    }))
    // Folder sync runs beside the command poll for the life of this lease. It
    // reads its own switch (folder-sync/config.json) every pass, so turning it
    // on or off never restarts the daemon; off, it only waits.
    const folderSync = startFolderSyncLoop(new FolderSyncEngine({
      stateDir, executorId: live.executorId, transport: createFolderSyncTransport(() => live),
    }), {
      onError: (error) => {
        console.error('[nessie-executor] folder sync failed:', error instanceof Error ? error.message : String(error))
      },
    })
    const heartbeat = createNonOverlappingExecutorTask(async () => {
      try {
        const software = await reportedSoftwareStatus()
        if (software.canInstall && software.draining !== undefined) {
          drainingForUpdate = software.draining && software.installedVersion !== software.targetVersion
          if (drainingForUpdate) await localInference.supervisor.drain().catch(() => undefined)
          else localInference.supervisor.resume()
        }
        // Closing never delays the next heartbeat: it runs beside it, serialised on its own,
        // and every heartbeat retries whatever an earlier one could not carry out.
        const close = await heartbeatExecutor(
          live, reportForServer(localMcp.current(), ownerRequestsGate.understood()), (allowed) => {
            codingBridge.connectionHealthy(allowed)
            monitor.connected(true)
          }, folderSync.summary(), executorApi, { status: software, onRequest: async request => {
            await requestSoftwareUpdate(request)
          } }, monitor.current(), (request) => {
            // The first upload carries the already sampled minute, without waiting for a new one.
            if (monitor.request(request)) cadence.wake(['heartbeat'])
          },
        )
        void codingBridge.close(close).catch(() => undefined)
      } catch (error) {
        await retainedRuntime.stopCurrent()
        await browserSessions.stopAll()
        await commandSessions.stopAll()
        await codingSessions.stopAll()
        monitor.connected(false)
        await codingBridge.connectionFailed('heartbeat_failed', error).catch(() => undefined)
        if (!shuttingDown) {
          try {
            live = await claimExecutor(stateDir, live)
            live = await localInference.supervisor.reconnect(live)
            // The doorbell proved the old connection epoch; it rings again under the new one.
            doorbell.restart()
          } catch (claimError) {
            await codingBridge.connectionFailed('claim_failed', claimError).catch(() => undefined)
            console.error('[nessie-executor] reconnect failed:', claimError instanceof Error ? claimError.message : String(claimError))
          }
        }
        console.error('[nessie-executor] heartbeat failed:', error instanceof Error ? error.message : String(error))
        return
      }
      try {
        await localInference.supervisor.heartbeat()
      } catch (error) {
        console.error('[nessie-executor] local inference heartbeat failed:', error instanceof Error ? error.message : String(error))
      }
    })
    // Local inference has no tick here: its host holds a socket and claims
    // when Nessie pushes work; only its inventory heartbeat rides the 20 s task.
    const idle = () => !commandPoll.current() && !screenPoll.current()
      && browserSessions.isIdle() && commandSessions.isIdle() && codingSessions.isIdle()
      && localInference.supervisor.isIdle()
      && !retainedRuntime.busy()
    const pollTick = createNonOverlappingExecutorTask(async () => {
      if (shuttingDown) return
      if (drainingForUpdate && idle() && await codingBridge.isIdle() && drainingForUpdate && idle()) {
        shuttingDown = true
        process.exitCode = 75 // supported supervisors retry against the selected immutable release
        finishUpdateDrain()
        return
      }
      // Existing work, including its follow-up commands and Close actions,
      // continues while the update waits. No session is stopped to make it idle.
      cadence.tick()
    })
    // The command poll and the session exchange: once a second, or the doorbell's slower
    // pace while it is open, and at once when it rings or a session changes here.
    const cadence = createDaemonCadence({
      commands: commandPoll, sessions: screenPoll, heartbeat,
      sessionsHot: () => relayScreens.hot() || Boolean(t3Lane?.hot()), monitorHot: monitor.watching,
    })
    wakeRetained = () => { if (!shuttingDown) cadence.wake(['sessions']) }
    const doorbell = new ExecutorDaemonDoorbell({
      state: () => live,
      onReady: (pollSeconds, connectionEpoch) => {
        ownerRequestsGate.ready(connectionEpoch)
        codingBridge.ownerRequestsChanged()
        cadence.ready(pollSeconds)
      },
      onWake: (topics) => { if (!shuttingDown) cadence.wake(topics) },
      onDown: () => cadence.down(),
    })
    const sessionChanged = (): void => {
      if (shuttingDown) return
      relayScreens.forceInventory()
      cadence.sessionChanged()
    }
    const changes = watchSessionChanges({ path: codingBridge.changeMarker, onChange: sessionChanged })
    const existingRefresh = createNonOverlappingExecutorTask(async () => {
      if (await codingBridge.refreshExisting().catch(() => false)) sessionChanged()
    })
    const commandInterval = setInterval(() => { void pollTick.run().catch(() => undefined) }, 250)
    const existingInterval = setInterval(() => { void existingRefresh.run() }, EXISTING_STATUS_REFRESH_MS)
    existingInterval.unref()
    cadence.wake(['heartbeat'])
    doorbell.start()
    try {
      await waitForExecutorDaemonShutdown(options.parentLiveness, updateReady)
    } finally {
      shuttingDown = true
      localMcp.stop()
      doorbell.stop()
      await t3Lane?.close()
      // Capture, publication, read demand and native/server withdrawal join
      // before global API cancellation and physical source owner release.
      await closeRetained()
      changes.stop()
      clearInterval(commandInterval)
      clearInterval(existingInterval)
      executorApi.cancelPending()
      // Its in-flight calls were just cancelled; whatever a transfer left is in its journal.
      await monitor.stop()
      await folderSync.stop()
      await localInference.supervisor.stop()
      await Promise.allSettled([
        ...(commandPoll.current() ? [commandPoll.current()] : []),
        ...(heartbeat.current() ? [heartbeat.current()] : []),
        ...(screenPoll.current() ? [screenPoll.current()] : []),
      ])
      await Promise.allSettled([
        browserSessions.stopAll(), commandSessions.stopAll(), codingSessions.stopAll(),
        // Describe leads its own process group, which a supervisor's stop of the daemon's group misses.
        stopKelpieDescribes(),
        // The bridge answers through the MCP session, so it closes before that session stops.
        withinShutdownBudget(codingBridge.shutdown()).then(() => mcpSessions.stopAll()),
      ])
    }
  } finally {
    await closeRetained()
    releaseT3Sources?.()
    try { await protectionRuntime?.release() } finally { await daemonLease.release() }
    if (retainedFailure) throw retainedFailure
  }
}
