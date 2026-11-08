import type { Readable } from 'node:stream'
import { enableLocalSessionBridge } from './local-session-bridge.js'
import type { ExecutorRuntime } from './coding-sessions-policy.js'

import { executorApi } from './api-client.js'
import { createExecutorBrowserSessionManager } from './browser-session-manager.js'
import { createExecutorCodingSessionManager } from './coding-session-manager.js'
import { createExecutorCommandSessionManager } from './command-session-manager.js'
import { claimExecutor, heartbeatExecutor, pollAndExecuteCommand } from './daemon.js'
import { createNonOverlappingExecutorTask, waitForExecutorDaemonShutdown } from './daemon-tasks.js'
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
import { createDaemonLiveApply } from './daemon-live-apply.js'
import { createDaemonLiveState, liveView } from './daemon-live-state.js'
import { watchLocalFiles } from './daemon-local-watch.js'
import { createDaemonOwnerPause } from './daemon-owner-pause.js'
import { createDaemonToolbox } from './daemon-tools.js'
import { stopKelpieDescribes } from './kelpie-detect.js'
import { startExecutorLocalInferenceSupervisor } from './local-inference-supervisor.js'
import { ownerPausePath } from './owner-pause.js'
import { createProgramRequestGate } from './program-request-gate.js'
import { openProgramRequestStore } from './program-requests.js'
import { LOCAL_MCP_REFRESH_INTERVAL_MS } from './local-mcp-report.js'
import { refreshLocalApps } from './local-mcp-apps.js'
import { localMcpPolicyOf } from './mcp-policy.js'
import { loadExecutorState, type ExecutorLocalState } from './state-store.js'
import { createDaemonCadence } from './daemon-cadence.js'
import { ExecutorDaemonDoorbell } from './daemon-doorbell.js'
import { createOwnerRequestsGate, reportForServer } from './owner-requests-gate.js'
import { watchSessionChanges } from './session-change-watch.js'
import { startComputerMonitor } from './computer-monitor.js'
import { PersonalInferenceGuard } from './personal-inference-guard.js'
import { reportedSoftwareStatus, requestSoftwareUpdate } from './updates/native-client.js'
import { join } from 'node:path'

// A shutdown that opted in to closing coding sessions gets this long to ask the bridge.
const CODING_SESSION_SHUTDOWN_BUDGET_MS = 5_000
// How often the Codex threads found open on this computer are asked whether they wait on their own client.
const EXISTING_STATUS_REFRESH_MS = 5_000
/** The file `state-store.ts` replaces atomically on every save of this team's state. */
const STATE_FILE = 'executor-state.json'

const withinShutdownBudget = (work: Promise<void>): Promise<void> => Promise.race([
  work.catch(() => undefined),
  new Promise<void>((settle) => { setTimeout(settle, CODING_SESSION_SHUTDOWN_BUDGET_MS).unref() }),
])

/**
 * Runs the paired executor and its sibling local Ollama host under one lease.
 *
 * Saving never restarts it: the owner's saves (`configure`, `pause`,
 * `resume`, a program request's answer) reach it through `watchLocalFiles`,
 * and it applies them on its current connection (`daemon-live-apply.ts`).
 */
export const serveExecutor = async (
  stateDir: string,
  state: ExecutorLocalState,
  options: { parentLiveness?: Readable; runtime?: ExecutorRuntime } = {},
): Promise<void> => {
  const daemonLease = await acquireExecutorDaemonLease(stateDir)
  let protectionRuntime: Awaited<ReturnType<PersonalInferenceGuard['registerRuntime']>> | null = null
  try {
    if (process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1') {
      protectionRuntime = await PersonalInferenceGuard.open().registerRuntime(`executor:${state.executorId}`)
    }
    // Read before the claim, so a team paused before it started never starts anything new.
    const pause = createDaemonOwnerPause(stateDir)
    await pause.load()
    const programRequests = openProgramRequestStore(stateDir)
    await programRequests.sweep()
    const claimed = await claimExecutor(stateDir, await enableLocalSessionBridge(stateDir, state, options.runtime))
    const localInference = await startExecutorLocalInferenceSupervisor(stateDir, claimed)
    const live = createDaemonLiveState(localInference.state)
    const liveApply = createDaemonLiveApply(stateDir, live)
    const browserSessions = createExecutorBrowserSessionManager(stateDir, live.view)
    const commandSessions = createExecutorCommandSessionManager(stateDir, live.view)
    const codingSessions = createExecutorCodingSessionManager(stateDir, live.view)
    // Whether this connection's Nessie reads what sessions wait on their owner for: its doorbell said ready.
    const ownerRequestsGate = createOwnerRequestsGate(() => live.current.connectionEpoch)
    // Coding sessions outlive runs and daemon restarts, so the daemon ends
    // them itself wherever it ends its other sessions.
    const toolbox = createDaemonToolbox({
      live, commandRules: liveView(() => live.commandRules), ownerRequestsGate, runtime: options.runtime,
      quiesce: async () => { await screenPoll.current()?.catch(() => undefined) },
    })
    const tools = () => toolbox.current
    const programGate = createProgramRequestGate({ store: programRequests })
    const monitor = startComputerMonitor(stateDir)
    const screenPoll = createNonOverlappingExecutorTask(() => tools().relayScreens(live.view).catch(() => undefined))
    let shuttingDown = false
    let drainingForUpdate = false
    let finishUpdateDrain: () => void = () => undefined
    const updateReady = new Promise<void>((resolve) => { finishUpdateDrain = resolve })
    // Paused or draining for an update, the local model host takes no new work either.
    const settleLocalInference = async (): Promise<void> => {
      if (drainingForUpdate || pause.paused()) await localInference.supervisor.drain().catch(() => undefined)
      else localInference.supervisor.resume()
    }
    // One store for the daemon's whole life. Building it per poll re-secured
    // the runtime directory every second, which on Windows is two native-helper
    // process spawns a second and nothing at all on POSIX.
    const recoveryStore = createExecutorCommandRecoveryStore(stateDir)
    const attachmentStore = createExecutorCommandAttachmentStore(stateDir)
    // Before the first poll, so no folder a new command writes can be swept.
    await sweepExecutorCommandAttachments(recoveryStore, attachmentStore).catch((error: unknown) => {
      console.error('[nessie-executor] attachment sweep failed:', error instanceof Error ? error.message : String(error))
    })
    const commandPoll = createNonOverlappingExecutorTask(async () => {
      try {
        // Between two commands, so nothing in flight uses the local apps it replaces.
        if (await toolbox.refresh().catch(() => false)) cadence.wake(['heartbeat'])
        const current = tools()
        await pollAndExecuteCommand(stateDir, live.current, {
          browserSessions, commandSessions, codingSessions, mcpSessions: current.mcpSessions,
          store: recoveryStore, sidecars: attachmentStore,
          // The bridge stamps each call with the rules that hold while it runs.
          codingBridge: current.codingBridge, ownerPaused: pause.paused,
          programRequests: { gate: programGate, allowOnce: live.allowOnce },
        })
      } catch (error) {
        // An image upload the next poll makes again says nothing about the
        // connection or the other sessions; stopping them for it ended a
        // person's browser and coding sessions over one slow answer from Nessie.
        if (commandPollFailureStopsSessions(error)) {
          await browserSessions.stopAll()
          await commandSessions.stopAll()
          await codingSessions.stopAll()
          // Host coding sessions outlive a failed poll; only a definitive or lasting failure closes them.
          await tools().codingBridge.connectionFailed('command_poll_failed', error).catch(() => undefined)
        }
        console.error('[nessie-executor] command poll failed:', error instanceof Error ? error.message : String(error))
      }
    })
    // Folder sync runs beside the command poll for the life of this lease. It
    // reads its own switch (folder-sync/config.json) every pass, so turning it
    // on or off never restarts the daemon; off, it only waits.
    const folderSync = startFolderSyncLoop(new FolderSyncEngine({
      stateDir, executorId: live.current.executorId, transport: createFolderSyncTransport(() => live.current),
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
          await settleLocalInference()
        }
        const bridge = tools().codingBridge
        // Closing never delays the next heartbeat: it runs beside it, serialised on its own,
        // and every heartbeat retries whatever an earlier one could not carry out.
        const close = await heartbeatExecutor(
          live.view, reportForServer(tools().localMcp.current(), ownerRequestsGate.understood()), (allowed) => {
            bridge.connectionHealthy(allowed)
            monitor.connected(true)
          }, folderSync.summary(), executorApi, { status: software, onRequest: async request => {
            await requestSoftwareUpdate(request)
          } }, monitor.current(), (request) => {
            // The first upload carries the already sampled minute, without waiting for a new one.
            if (monitor.request(request)) cadence.wake(['heartbeat'])
          }, pause.report(live.current.connectionEpoch),
        )
        void bridge.close(close).catch(() => undefined)
        await liveApply.retry().catch(() => undefined)
      } catch (error) {
        await browserSessions.stopAll()
        await commandSessions.stopAll()
        await codingSessions.stopAll()
        monitor.connected(false)
        await tools().codingBridge.connectionFailed('heartbeat_failed', error).catch(() => undefined)
        if (!shuttingDown) {
          try {
            // The claim submits the saved revision itself, under its new epoch.
            live.set(await claimExecutor(stateDir, live.current))
            liveApply.submitted()
            live.set(await localInference.supervisor.reconnect(live.current))
            // The doorbell proved the old connection epoch; it rings again under the new one.
            doorbell.restart()
          } catch (claimError) {
            await tools().codingBridge.connectionFailed('claim_failed', claimError).catch(() => undefined)
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
    const pollTick = createNonOverlappingExecutorTask(async () => {
      if (shuttingDown) return
      if (drainingForUpdate && idle() && await tools().codingBridge.isIdle() && drainingForUpdate && idle()) {
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
      sessionsHot: () => tools().relayScreens.hot(), monitorHot: monitor.watching,
    })
    const doorbell = new ExecutorDaemonDoorbell({
      state: () => live.current,
      onReady: (pollSeconds, connectionEpoch) => {
        ownerRequestsGate.ready(connectionEpoch)
        tools().codingBridge.ownerRequestsChanged()
        cadence.ready(pollSeconds)
      },
      onWake: (topics) => { if (!shuttingDown) cadence.wake(topics) },
      onDown: () => cadence.down(),
    })
    const sessionChanged = (): void => {
      if (shuttingDown) return
      tools().relayScreens.forceInventory()
      cadence.sessionChanged()
    }
    const changes = watchSessionChanges({ path: () => tools().codingBridge.changeMarker(), onChange: sessionChanged })
    const existingRefresh = createNonOverlappingExecutorTask(async () => {
      if (await tools().codingBridge.refreshExisting().catch(() => false)) sessionChanged()
    })
    // Under the `installed` local-apps policy, a local app installed, removed or switched
    // off is a new revision; saving it reaches `applySaved` below like any other save.
    const proposeLocalApps = createNonOverlappingExecutorTask(async () => {
      const saved = await loadExecutorState(stateDir)
      if (localMcpPolicyOf(saved).mode === 'installed') await refreshLocalApps(stateDir, saved)
    })
    const refreshApps = (): void => {
      void proposeLocalApps.run().catch((error: unknown) => {
        console.error('[nessie-executor] local apps were not refreshed:', error instanceof Error ? error.message : String(error))
      })
    }
    const localAppsInterval = setInterval(refreshApps, LOCAL_MCP_REFRESH_INTERVAL_MS)
    localAppsInterval.unref()
    // The owner's saves on this computer, applied where the daemon stands.
    const applySaved = createNonOverlappingExecutorTask(async () => {
      if (await liveApply.reload()) cadence.wake(['commands'])
    })
    const applyPause = createNonOverlappingExecutorTask(async () => {
      if (!await pause.load()) return
      await settleLocalInference()
      // Nessie hears it on the next heartbeat, which goes now.
      cadence.wake(['heartbeat'])
    })
    const saved = watchLocalFiles({
      paths: [join(stateDir, STATE_FILE), ownerPausePath(stateDir)],
      onChange: (path) => {
        if (shuttingDown) return
        void (path === ownerPausePath(stateDir) ? applyPause : applySaved).run().catch(() => undefined)
      },
    })
    if (pause.paused()) await settleLocalInference()
    const commandInterval = setInterval(() => { void pollTick.run().catch(() => undefined) }, 250)
    const existingInterval = setInterval(() => { void existingRefresh.run() }, EXISTING_STATUS_REFRESH_MS)
    existingInterval.unref()
    cadence.wake(['heartbeat'])
    doorbell.start()
    // Anything saved between the start-up reads and the watch's first look.
    void applySaved.run().catch(() => undefined)
    void applyPause.run().catch(() => undefined)
    refreshApps()
    try {
      await waitForExecutorDaemonShutdown(options.parentLiveness, updateReady)
    } finally {
      shuttingDown = true
      tools().localMcp.stop()
      saved.stop()
      doorbell.stop()
      changes.stop()
      clearInterval(commandInterval)
      clearInterval(existingInterval)
      clearInterval(localAppsInterval)
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
      const { codingBridge, mcpSessions } = tools()
      await Promise.allSettled([
        browserSessions.stopAll(), commandSessions.stopAll(), codingSessions.stopAll(),
        // Describe leads its own process group, which a supervisor's stop of the daemon's group misses.
        stopKelpieDescribes(),
        // The bridge answers through the MCP session, so it closes before that session stops.
        withinShutdownBudget(codingBridge.shutdown()).then(() => mcpSessions.stopAll()),
      ])
    }
  } finally {
    try { await protectionRuntime?.release() } finally { await daemonLease.release() }
  }
}
