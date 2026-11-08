import { RunIdSchema, type ExecutorCommandEnvelope } from '@nessie/executor-protocol'

import type { ExecutorBrowserSessionManager } from './browser-session-manager.js'
import type { ExecutorCodingSessionManager } from './coding-session-manager.js'
import { codingSessionsPolicyOf } from './coding-sessions-policy.js'
import {
  createExecutorCommandAttachmentStore,
  deliverExecutorCommandAttachments,
  sweepExecutorCommandAttachments,
} from './command-attachments.js'
import { watchLegacyCancellation } from './command-cancellation.js'
import { createCommandDispatcher } from './command-dispatcher.js'
import { createExecutorCommandJournal } from './command-journal.js'
import type { ExecutorCommandSessionManager } from './command-session-manager.js'
import { createDaemonCommandPoll } from './daemon-command-poll.js'
import type { DaemonLiveState } from './daemon-live-state.js'
import type { DaemonTools } from './daemon-tools.js'
import { executeExecutorCommand, sendExecutorCommandReceipt, uploadExecutorCommandAttachment } from './daemon.js'
import type { ProgramRequestGate } from './program-request-gate.js'
import { removeSessionsFile, writeSessionsFile } from './session-snapshot.js'
import { clearSessionStop, listSessionStops } from './session-stops.js'

/**
 * The daemon's command side: the journal, the dispatcher that runs held
 * commands side by side, the signed poll that feeds it, the owner's session
 * stops, and the `sessions.json` the apps read. Built once for the daemon's
 * life; `daemon-server.ts` runs `poll` on its cadence.
 */
export const createDaemonCommands = (input: {
  stateDir: string
  live: DaemonLiveState
  browserSessions: ExecutorBrowserSessionManager
  commandSessions: ExecutorCommandSessionManager
  codingSessions: ExecutorCodingSessionManager
  tools: () => DaemonTools
  paused: () => boolean
  programGate: ProgramRequestGate
  /** Something the poll reports changed: poll now. */
  onChange: () => void
  log?: (message: string) => void
}) => {
  const { stateDir, live, browserSessions, commandSessions, codingSessions } = input
  const log = input.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  const journal = createExecutorCommandJournal(stateDir)
  const sidecars = createExecutorCommandAttachmentStore(stateDir)

  const endRun = async (runId: string): Promise<void> => {
    await Promise.allSettled([
      browserSessions.stop(runId), commandSessions.stop(runId), codingSessions.stop(runId),
    ])
  }

  // Tears down only the backend this command owns; other sessions on the
  // computer keep their own lifetimes. VM teardown ends every guest process.
  const cancelBackend = async (command: ExecutorCommandEnvelope): Promise<void> => {
    const runId = RunIdSchema.parse(command.payload.runId)
    if (command.operationKey.startsWith('browser.')) await browserSessions.stop(runId)
    if (command.operationKey === 'command.run') await commandSessions.stop(runId)
    if (command.operationKey.startsWith('coding.')) await codingSessions.stop(runId)
  }

  let writing: Promise<void> | null = null
  let writeAgain = false
  let stopped = false
  const writeSessions = (): void => {
    if (stopped) return
    if (writing) {
      writeAgain = true
      return
    }
    writing = writeSessionsFile(stateDir, dispatcher.sessions()).catch((error: unknown) => {
      log(`the sessions list was not saved: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      writing = null
      if (writeAgain) {
        writeAgain = false
        writeSessions()
      }
    })
  }

  const dispatcher = createCommandDispatcher({
    journal,
    receipt: (receipt) => sendExecutorCommandReceipt(live.current, receipt),
    attachments: {
      deliver: ({ command, delivered, journal: progress, result }) => deliverExecutorCommandAttachments({
        command, delivered, journal: progress, result, sidecars,
        // The reason names only Nessie's own refusal; the image stays here.
        onWithdrawn: (reference, reason) => {
          log(`image ${reference.attachmentDigest} of command ${command.commandId} was not delivered: ${reason}`)
        },
        // Signed under the connection that holds when each image goes, not the one at start.
        upload: (image) => uploadExecutorCommandAttachment(live.current)(image),
      }),
      release: (commandId) => sidecars.remove(commandId),
    },
    // The result itself stays on this machine: it can quote program output.
    onResultRefused: (command) => {
      log(`Nessie refused the result of ${command.operationKey} command ${command.commandId}; `
        + 'it was reported as EXECUTOR_RESULT_REFUSED instead.')
    },
    execute: (command, { signal, ownerWait }) => {
      const tools = input.tools()
      return executeExecutorCommand(stateDir, live.current, command, {
        attachments: sidecars, browserSessions, codingSessions, commandSessions,
        mcpSessions: tools.mcpSessions, codingBridge: tools.codingBridge, signal,
        ownerPaused: input.paused,
        programRequests: { gate: input.programGate, ownerWait },
      })
    },
    cancelBackend,
    endRun,
    legacyCancelWatch: (command, onCancel) => watchLegacyCancellation({ command, onCancel, state: () => live.current }),
    bridge: () => codingSessionsPolicyOf(live.current.descriptor.codingSessions, live.current.mcpServers)?.server.name,
    paused: input.paused,
    onChange: () => {
      writeSessions()
      input.onChange()
    },
    onSessionClosed: (sessionId) => {
      void clearSessionStop(stateDir, sessionId).catch(() => undefined)
    },
    log,
  })

  const poll = createDaemonCommandPoll({ state: () => live.current, dispatcher, log })

  return {
    dispatcher,
    poll: poll.poll,
    /** Takes up the journal's commands and the owner's stops; before the first poll. */
    start: async (): Promise<void> => {
      // Before any command writes, so no folder a new command writes can be swept.
      await sweepExecutorCommandAttachments(journal, sidecars).catch((error: unknown) => {
        log(`attachment sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      await dispatcher.start()
      await applyStops()
      writeSessions()
    },
    applyStops,
    /** Starts nothing new, lets running commands finish, and removes the sessions list. */
    stop: async (): Promise<void> => {
      await dispatcher.shutdown()
      stopped = true
      await writing
      await removeSessionsFile(stateDir).catch(() => undefined)
    },
  }

  /** The owner's stops, saved by `session stop`; a stop already applied changes nothing. */
  async function applyStops(): Promise<void> {
    for (const sessionId of await listSessionStops(stateDir)) {
      if (!dispatcher.isStopped(sessionId)) dispatcher.stopSession(sessionId)
    }
  }
}

export type DaemonCommands = ReturnType<typeof createDaemonCommands>
