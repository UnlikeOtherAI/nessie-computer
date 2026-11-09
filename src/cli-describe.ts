import { existingClaudeChannelConfiguration } from './existing-session/setup.js'
import { existingSessionsEnabled } from './existing-session/settings.js'
import { describeExecutorWithLocalApps } from './describe.js'
import { readLocalAppStartStatus } from './local-app-start-status.js'
import { withLocalAppStartStates } from './local-mcp-apps.js'
import { describeFolderSync } from './folder-sync/console-state.js'
import { listProgramRequests } from './program-requests.js'
import { configureExecutorLocalPolicy } from './pair.js'
import { requestedMcpServers } from './mcp-server-changes.js'
import type { LocalCommandPolicy } from './command-policy.js'
import type { ExecutorConfigurationSettings } from './configuration-input.js'
import { teamPaused } from './cli-teams.js'
import { loadExecutorState, type ExecutorLocalState } from './state-store.js'
import type { ExecutorWorkspaceFolder } from './workspace-folder-arguments.js'

/**
 * One team's full settings, the JSON `describe --state-dir` prints and
 * `access show --json` prints: the same answer for the apps and for a person.
 */
export const describeTeam = async (stateDir: string, state: ExecutorLocalState) => {
  const description = await describeExecutorWithLocalApps(state)
  return {
    ...description,
    localApps: withLocalAppStartStates(description.localApps, await readLocalAppStartStatus(stateDir)),
    ...await teamSettings(stateDir, state),
  }
}

const teamSettings = async (stateDir: string, state: ExecutorLocalState) => ({
  paused: await teamPaused(stateDir),
  pendingProgramRequests: (await listProgramRequests(stateDir)).length,
  folderSync: await describeFolderSync(stateDir, state.executorId),
  existingCodingSessionsEnabled: await existingSessionsEnabled(stateDir),
  existingClaudeChannelConfiguration: existingClaudeChannelConfiguration(state, stateDir),
})

export type TeamDescription = Awaited<ReturnType<typeof describeTeam>>

/** The same answer from the team's state as it is saved now. */
export const describeTeamAt = async (stateDir: string): Promise<TeamDescription> =>
  describeTeam(stateDir, await loadExecutorState(stateDir))

/** One change to a team's Access, in the terms `configure --configuration-input-stdin` takes. */
export type AccessChange = {
  workspaceFolders?: readonly ExecutorWorkspaceFolder[]
  commandPolicy?: LocalCommandPolicy
  settings?: ExecutorConfigurationSettings
  mcpServerRemovals?: string[]
}

/**
 * Saves a change through the writer `configure` uses, from freshly read state:
 * the operations stay as they are, every key the change leaves out keeps what
 * is saved, and a running team applies it on its current connection.
 */
export const saveAccess = async (stateDir: string, change: AccessChange): Promise<ExecutorLocalState> => {
  const state = await loadExecutorState(stateDir)
  return configureExecutorLocalPolicy(stateDir, state, state.descriptor.operationKeys, undefined, undefined,
    change.workspaceFolders ?? state.workspaceFolders, undefined,
    change.mcpServerRemovals
      ? requestedMcpServers(state.mcpServers, { mcpServerRemovals: change.mcpServerRemovals }) : undefined,
    {}, change.commandPolicy, change.settings ?? {})
}
