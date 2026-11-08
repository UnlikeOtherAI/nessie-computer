
import { describeTeamAt, saveAccess, type AccessChange, type TeamDescription } from './cli-describe.js'
import type { HostRun } from './cli-output.js'
import { localCommandPolicyOf, type LocalCommandPolicy } from './command-policy.js'
import { allowedOriginsOf } from './configuration-input.js'
import type { CliTeam, LocalTeam, ServiceTeam } from './cli-teams.js'
import { existingSessionsEnabled, setExistingSessionsEnabled } from './existing-session/settings.js'
import { applyInferenceEndpointOperation, inferenceEndpointStatus } from './inference-endpoint-cli.js'
import { setOwnerPaused } from './owner-pause.js'
import { answerProgramRequest } from './program-request-cli.js'
import { listProgramRequests, type ProgramRequest, type ProgramRequestAnswer } from './program-requests.js'
import { stopTeamSession } from './session-cli.js'
import { readSessions, type SessionView } from './session-snapshot.js'
import { loadExecutorState } from './state-store.js'
import type { UnpairResult } from './unpair.js'
import { grantServiceFolder } from './windows-service-grant.js'
import { expectAnswer, serviceRequests, serviceTeamList, type ServiceCall } from './windows-service-control.js'

/**
 * What a command can do to one team, wherever the team runs. A team in a
 * state folder is changed through the functions the apps' plumbing verbs
 * call; a team the Windows service runs is changed through the service's own
 * commands, the ones the Windows app sends. One set of words, one behaviour.
 */

export type TeamChange = AccessChange & { existingCodingSessionsEnabled?: boolean }
export type TeamRequest = ProgramRequest & { agentName?: string }
export type InferenceOperation = { operation: 'status' }
  | { operation: 'save'; id: string; name: string; baseUrl: string; scope: 'local' | 'network'; apiKey?: string }
  | { operation: 'remove'; id: string }
export type InferenceStatus = Awaited<ReturnType<typeof inferenceEndpointStatus>>

/** The Access settings a change reads and writes, without discovering local apps. */
export type TeamAccess = {
  commandPolicy: LocalCommandPolicy
  folders: Array<{ name: string; path: string }>
  allowedOrigins: string[]
  browserConfigured: boolean
  existingCodingSessionsEnabled: boolean
}

export type TeamOps = {
  /** Everything the team can use, local apps included: `describe`'s answer. */
  describe: () => Promise<TeamDescription>
  access: () => Promise<TeamAccess>
  /** Saves a change and answers with the Access settings as they are now; a running team applies it at once. */
  save: (change: TeamChange) => Promise<TeamAccess>
  setPaused: (paused: boolean) => Promise<{ paused: boolean; since?: string }>
  programRequests: () => Promise<TeamRequest[]>
  answer: (request: ProgramRequest, answer: ProgramRequestAnswer) => Promise<void>
  /** Now working: the team's sessions, and Stop for one, answering with the sessions left. */
  sessions: () => Promise<SessionView[]>
  stopSession: (sessionId: string) => Promise<SessionView[]>
  inference: (operation: InferenceOperation) => Promise<InferenceStatus>
  remove: () => Promise<UnpairResult>
}

export type TeamOpsHost = {
  service: ServiceCall
  run: HostRun
  /** Removes a state folder's connection; `unpairExecutor` outside tests. */
  unpair: (stateDir: string) => Promise<UnpairResult>
}

const localAccess = async (stateDir: string): Promise<TeamAccess> => {
  const state = await loadExecutorState(stateDir)
  return { commandPolicy: localCommandPolicyOf(state), allowedOrigins: allowedOriginsOf(state),
    folders: state.workspaceFolders.map(({ name, path }) => ({ name, path })),
    browserConfigured: Boolean(state.browserSandbox),
    existingCodingSessionsEnabled: await existingSessionsEnabled(stateDir) }
}

const accessOf = (description: TeamDescription): TeamAccess => ({
  commandPolicy: description.commandPolicy, allowedOrigins: [...description.reach.allowedOrigins],
  folders: description.reach.folders.map(({ name, path }) => ({ name, path })),
  browserConfigured: description.sandbox.browserConfigured,
  existingCodingSessionsEnabled: description.existingCodingSessionsEnabled,
})

const localOps = (team: LocalTeam, host: TeamOpsHost): TeamOps => ({
  describe: () => describeTeamAt(team.stateDir),
  access: () => localAccess(team.stateDir),
  save: async ({ existingCodingSessionsEnabled: conversations, ...change }) => {
    if (conversations !== undefined) await setExistingSessionsEnabled(team.stateDir, conversations)
    if (Object.keys(change).length) await saveAccess(team.stateDir, change)
    return localAccess(team.stateDir)
  },
  setPaused: async (paused) => {
    const pause = await setOwnerPaused(team.stateDir, paused)
    return { paused: pause !== null, ...(pause ? { since: pause.since } : {}) }
  },
  programRequests: () => listProgramRequests(team.stateDir),
  answer: async (request, answer) => {
    await answerProgramRequest(team.stateDir, await loadExecutorState(team.stateDir),
      { answer, id: request.id, json: false }, () => undefined)
  },
  sessions: () => readSessions(team.stateDir),
  stopSession: (sessionId) => stopTeamSession(team.stateDir, sessionId),
  inference: async (operation) => {
    if (operation.operation !== 'status') await applyInferenceEndpointOperation(team.stateDir, operation)
    return inferenceEndpointStatus(team.stateDir)
  },
  remove: () => host.unpair(team.stateDir),
})

/**
 * The configuration the service's `configure` takes: what the team has now,
 * as `describe` reports it, with this change on top — the same proposal the
 * Windows app makes, so no change narrows a setting it was not about.
 */
export const serviceConfigurationInput = (current: TeamDescription, change: TeamChange) => ({
  operationKeys: [...current.policy.operations],
  workspaceFolders: (change.workspaceFolders ?? current.reach.folders).map(({ name, path }) => ({ name, path })),
  ...(change.commandPolicy ? { commandPolicy: change.commandPolicy } : {}),
  ...(change.settings?.mcpPolicy ? { mcpPolicy: change.settings.mcpPolicy } : {}),
  ...(change.settings?.allowedOrigins ? { allowedOrigins: change.settings.allowedOrigins } : {}),
  ...(change.mcpServerRemovals ? { mcpServerRemovals: change.mcpServerRemovals } : {}),
  ...(change.existingCodingSessionsEnabled === undefined ? {}
    : { existingCodingSessionsEnabled: change.existingCodingSessionsEnabled }),
})

const serviceOps = (team: ServiceTeam, host: TeamOpsHost): TeamOps => {
  const id = team.executorId
  const ask = async (request: Parameters<ServiceCall>[0], status: string) => (
    expectAnswer(await host.service(request), status))
  const list = (answer: Record<string, unknown>, key: string): unknown[] => (
    Array.isArray(answer[key]) ? answer[key] : [])
  const describe = async () => (await ask(serviceRequests.describe(id), 'describe')).description as TeamDescription
  const requests = (answer: Record<string, unknown>) => list(answer, 'requests') as TeamRequest[]
  const sessionsOf = (answer: Record<string, unknown>) => list(answer, 'sessions') as SessionView[]
  return {
    describe,
    access: async () => accessOf(await describe()),
    save: async (change) => {
      const current = await describe()
      // The service reads a folder under its own account, so a new one is
      // granted to it first: the Windows app's one elevated step.
      for (const folder of change.workspaceFolders ?? []) {
        const known = current.reach.folders.some((existing) => existing.path === folder.path)
        if (!known) await grantServiceFolder(host.run, folder.path)
      }
      await ask(serviceRequests.configure(id, serviceConfigurationInput(current, change)), 'ok')
      return accessOf(await describe())
    },
    setPaused: async (paused) => {
      const rows = serviceTeamList(await host.service(serviceRequests.setPaused(id, paused)))
      const row = rows.find((entry) => entry.executorId === id)
      return { paused: row?.paused ?? paused }
    },
    programRequests: async () => requests(await ask(serviceRequests.programRequests(id), 'programRequests')),
    answer: async (request, answer) => { await ask(serviceRequests.answer(id, request.id, answer), 'programRequests') },
    sessions: async () => sessionsOf(await ask(serviceRequests.sessions(id), 'sessions')),
    stopSession: async (sessionId) => sessionsOf(await ask(serviceRequests.stopSession(id, sessionId), 'sessions')),
    inference: async (operation) => (await ask(serviceRequests.inference(id, operation), 'inferenceConnections'))
      .connections as InferenceStatus,
    remove: async () => ({ status: 'removed', signedOff: (await ask(serviceRequests.remove(id), 'removed')).signedOff === true }),
  }
}

export const teamOps = (team: CliTeam, host: TeamOpsHost): TeamOps => (
  team.route === 'local' ? localOps(team, host) : serviceOps(team, host))
