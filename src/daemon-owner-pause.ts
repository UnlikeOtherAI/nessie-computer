import type { OwnerPauseReport } from './daemon-connection.js'
import { readOwnerPause } from './owner-pause.js'

/**
 * The running daemon's reading of the owner's pause (`owner-pause.ts`).
 *
 * While paused, the dispatch refuses every new command with
 * `EXECUTOR_OWNER_PAUSED`, running work finishes, the local model host takes
 * nothing new, and the heartbeat says `ownerPaused: true`. A pause file that
 * cannot be read counts as paused.
 *
 * An older Nessie refuses the heartbeat field (`daemon-connection.ts`). The
 * daemon then leaves it out for the rest of that connection — a reconnect may
 * meet an upgraded Nessie, so it tries again then — and says once that Nessie
 * cannot show the pause. The team stays paused here either way.
 */
export const createDaemonOwnerPause = (
  stateDir: string,
  log: (message: string) => void = (message) => { console.error(`[nessie-executor] ${message}`) },
) => {
  let paused = true
  let unheardOn: string | undefined
  return {
    /** Reads the saved pause; true when the reading changed. */
    load: async (): Promise<boolean> => {
      const before = paused
      try {
        paused = (await readOwnerPause(stateDir)) !== null
      } catch (error) {
        paused = true
        log(`the pause file could not be read, so this team stays paused: ${
          error instanceof Error ? error.message : String(error)}`)
      }
      return paused !== before
    },
    paused: (): boolean => paused,
    report: (connectionEpoch: string | undefined): OwnerPauseReport => ({
      paused: paused && unheardOn !== connectionEpoch,
      refused: () => {
        if (unheardOn === connectionEpoch) return
        unheardOn = connectionEpoch
        log('this Nessie does not accept the paused flag. The team stays paused on this computer, '
          + 'but Nessie cannot show that it is paused.')
      },
    }),
  }
}
