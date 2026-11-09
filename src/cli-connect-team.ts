import type { ExecutorLocalState } from './state-store.js'

export type ConnectTeamDependencies = {
  /** Claims a new connection epoch for this team. */
  claim: (stateDir: string, state: ExecutorLocalState) => Promise<ExecutorLocalState>
  /** Tells Nessie a team its owner paused is paused, before anything could be routed here. */
  reportPause: (stateDir: string, live: ExecutorLocalState) => Promise<void>
  /** Registers this computer's local inference host and opens its session. */
  connectLocal: (stateDir: string, live: ExecutorLocalState) => Promise<{ session: { stop: () => Promise<void> } }>
}

/**
 * `connect`: proves Nessie still accepts this computer for the team and
 * registers its local inference host, then ends. The daemon (`serve`) holds
 * the host's socket for as long as it runs. The session `connect` opened was
 * never stopped, so the command never exited; the Mac app runs `connect`
 * before `serve` and waits for it, so on 9 November its team never started.
 */
export const connectTeam = async (
  stateDir: string, state: ExecutorLocalState, dependencies: ConnectTeamDependencies,
): Promise<void> => {
  const live = await dependencies.claim(stateDir, state)
  await dependencies.reportPause(stateDir, live)
  const local = await dependencies.connectLocal(stateDir, live)
  await local.session.stop()
}
