import { codingSessionsConfigInput, loadCodingSessionsConfig } from './coding-session/config.js'
import { codingSessionsConfigPath, type ExecutorRuntime } from './coding-sessions-policy.js'
import { configureExecutorLocalPolicy } from './pair.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * Every pairing offers the local session bridge: existing native sessions,
 * and terminal sessions that start the program an agent names under this
 * computer's command rules. Existing executor authority is sufficient, so a
 * pairing made before either existed gains them when its daemon starts. An
 * older build's configured terminal program is removed from the file on the
 * way; every other reviewed setting is kept as it is.
 */
export const enableLocalSessionBridge = async (
  stateDir: string, state: ExecutorLocalState, runtime?: ExecutorRuntime,
): Promise<ExecutorLocalState> => {
  const previous = state.descriptor.codingSessions
  if (previous?.existingSessions && previous.terminalCommands === 'commandRules') return state
  const loaded = previous ? await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir)) : undefined
  if (loaded && loaded.digest !== previous?.configDigest) {
    throw new Error('The coding-session configuration changed. Apply the local configuration before starting the executor.')
  }
  return configureExecutorLocalPolicy(stateDir, state,
    [...new Set([...state.descriptor.operationKeys, 'mcp.tools', 'mcp.call'])],
    undefined, undefined, undefined, undefined, undefined,
    {
      requested: loaded ? codingSessionsConfigInput(loaded.config) : { roots: [], agents: {}, existingSessions: true },
      upgrade: true,
      runtime,
    })
}
