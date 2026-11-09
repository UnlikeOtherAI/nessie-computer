import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existingAuthorityWriter } from './existing-session/authority.js'

import {
  EXISTING_CODING_SESSION_OWNER_KEY,
  EXECUTOR_CODING_SESSION_REPORT_MAXIMUM,
  ExecutorCodingSessionCloseListSchema,
  executorCodingSessionOwnerKeyInput,
  ExecutorCodingSessionSummarySchema,
  ExecutorSessionScreenSchema,
  ExecutorSessionActionReceiptSchema, type ExecutorSessionAction, type ExecutorSessionActionReceipt,
  ExecutorSessionConversationSchema,
  type ExecutorSessionConversation,
  ExecutorSessionInventoryPageSchema,
  type ExecutorSessionInventoryPage,
  type ExecutorSessionViewRequest,
  type ExecutorSessionScreen,
  type ExecutorCodingSessionClose,
  type ExecutorCodingSessionsFacts,
  type ExecutorCodingSessionSummary,
  type ExecutorMcpCallOwner,
} from '@nessie/executor-protocol'

import type { LocalCommandPolicy } from './command-policy.js'
import { loadCodingSessionsConfig } from './coding-session/config.js'
import { codingSessionChangeMarker } from './coding-session/session-change-marker.js'
import { ownerRequestsLeaseWriter } from './coding-session/owner-requests-lease.js'
import { codingSessionPaths } from './coding-session/session-files.js'
import { readSessionMeta } from './coding-session/session-requests.js'
import { readSessionScreen } from './coding-session/session-view.js'
import { requireManagedSessionEvidence } from './coding-session/session-authority.js'
import { callSessionSurface } from './session-surface-call.js'
import {
  CODING_SESSION_COMMAND_META,
  CODING_SESSION_COMMAND_RULES_META,
  CODING_SESSION_DAEMON_CONTROL_META,
  CODING_SESSION_OWNER_META,
  CODING_SESSION_AUTHORITY_META, CODING_SESSION_PAIRING_SOURCE_META,
  CODING_SESSION_CONNECTION_META,
} from './coding-session/meta-keys.js'
import {
  codingSessionsPolicyOf,
  codingSessionsServerConfigPath,
  isBuiltinCodingSessionsServer,
} from './coding-sessions-policy.js'
import { SUPERVISOR_ENVIRONMENT_VARIABLE } from './host-platform.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'

/**
 * The daemon's half of coding-sessions.md §3 and §5: who each bridge call is
 * for, and how sessions end when the daemon's authority does.
 *
 * Owners. The worker stamps an `mcp.call` payload with `owner: {agentId,
 * actorUserId, contextId?}`. For calls to the executor's own coding-sessions
 * bridge — and no other server, ever — the daemon turns it into
 * `_meta['nessie/owner'] = sha256(executorId|agentId|actorUserId[|contextId])`
 * and adds `_meta['nessie/command']`, the command id that makes a replay a
 * no-op. A ticket's context is its own owner, so a close for the person's own
 * sessions with that agent never reaches it, and each ticket has its own
 * quota. The model's `arguments` are passed on untouched. Beside them go this
 * computer's command rules as the daemon applies them, which decide what a
 * terminal session may start — the rules a sandboxed command meets too.
 *
 * Teardown. Coding sessions are built to outlive a bridge, a daemon restart
 * and a dropped connection, so a failed poll or heartbeat alone closes
 * nothing: a network blip or an API deploy must not end every 45-minute turn
 * on the machine for good. Sessions close through the bridge's daemon-only
 * `session_close_all` when the daemon's authority has provably ended — the API
 * answers that the executor is unknown or revoked, or refuses its proof — or
 * once no heartbeat has succeeded for `DISCONNECT_CLOSE_MS`, and at shutdown
 * when the reviewed configuration opts in. The daemon keeps the owner keys it
 * has dispatched for; sessions from an earlier daemon life may exist too, so
 * the first teardown after start closes everything, and once one has
 * succeeded a teardown with no owner dispatched since is skipped rather than
 * starting a bridge process to close nothing.
 *
 * The heartbeat response's `codingSessionClose` closes named owners' sessions
 * (or one of them). An instruction the bridge could not carry out — a bridge
 * in start-failure backoff, a call that timed out — is kept and tried again
 * on every later heartbeat that still lists it, so a revoked lease or a
 * person's Close is never silently dropped, and one the API no longer lists
 * (done, a day old, or withdrawn because the owner launched again) is not
 * retried into the new session. The daemon-only `session_list_all` feeds the
 * local-MCP report.
 */

export const codingSessionOwnerKey = (executorId: string, owner: ExecutorMcpCallOwner): string => (
  `sha256:${createHash('sha256').update(executorCodingSessionOwnerKeyInput(executorId, owner)).digest('hex')}`
)

/**
 * The named servers as this daemon starts them. The built-in bridge also gets
 * the daemon's supervisor marker, which the MCP SDK's minimal environment
 * would otherwise drop, so a host under the Windows service is refused by the
 * marker as well as by its token. No other server's environment changes.
 */
export const withDaemonSupervisor = (
  servers: readonly ExecutorLocalMcpServer[], environment: NodeJS.ProcessEnv = process.env,
): ExecutorLocalMcpServer[] => {
  const supervisor = environment[SUPERVISOR_ENVIRONMENT_VARIABLE]
  return servers.map((server) => (supervisor && isBuiltinCodingSessionsServer(server)
    ? { ...server, env: { ...server.env, [SUPERVISOR_ENVIRONMENT_VARIABLE]: supervisor } }
    : server))
}

/** How long the daemon may go without a successful heartbeat before it closes every coding session. */
export const DISCONNECT_CLOSE_MS = 10 * 60_000

/** API answers that end this daemon's authority for good: the executor is gone, or its key no longer proves it. */
const DEFINITIVE_FAILURES = new Set(['EXECUTOR_NOT_FOUND', 'EXECUTOR_DAEMON_PROOF_INVALID'])

const PENDING_CLOSE_MAXIMUM = 64

export type CodingSessionsDaemon = {
  validateSessionAuthority: (scope: import('@nessie/executor-protocol').ExecutorCodingSessionAuthority,
    phase: 'execute' | 'publish') => Promise<import('@nessie/executor-protocol').ExecutorCodingSessionAuthority>
  isIdle: () => Promise<boolean>
  action?: (action: ExecutorSessionAction) => Promise<ExecutorSessionActionReceipt>
  conversation?: (request: ExecutorSessionViewRequest) => Promise<ExecutorSessionConversation | null>
  inventory: (cursor?: string) => Promise<ExecutorSessionInventoryPage | undefined>
  screen: (request: ExecutorSessionViewRequest) => Promise<ExecutorSessionScreen | null>
  /** The reserved `_meta` for one call, command rules included: defined only for the built-in bridge. */
  callMeta: (
    server: string, input: { commandId: string; owner?: ExecutorMcpCallOwner;
      codingSessionAuthority?: import('@nessie/executor-protocol').ExecutorCodingSessionAuthority },
  ) => Record<string, unknown> | undefined
  /** Every session on this machine, as the daemon's authority ends. */
  closeAll: (reason: string) => Promise<void>
  /** A failed poll, heartbeat or claim: closes only when the failure is definitive or has lasted. */
  connectionFailed: (reason: string, error: unknown) => Promise<void>
  /** A heartbeat the API accepted. */
  connectionHealthy: (existingSessionsAllowed?: boolean) => void
  /** Nessie's reading of requests may have changed (the doorbell said `ready`): tells the hosts at once. */
  ownerRequestsChanged: () => void
  /**
   * The control plane's instructions from a heartbeat response, plus any an
   * earlier heartbeat could not carry out; anything malformed is ignored.
   */
  close: (instructions: unknown) => Promise<void>
  /** At shutdown, when the reviewed configuration opts in. */
  shutdown: () => Promise<void>
  /** The open sessions for the local-MCP report, or undefined when the bridge could not say. */
  report: () => Promise<ExecutorCodingSessionSummary[] | undefined>
  /** The file every session host replaces when a session changes, or undefined without a bridge. */
  changeMarker: () => string | undefined
  /**
   * Re-reads the status of the Codex threads found open on this computer (at
   * most every five seconds, never their history): true when one started or
   * stopped waiting on its own client's approval or input.
   */
  refreshExisting: () => Promise<boolean>
}

type TextResult = { content?: { text?: unknown }[]; success?: unknown }

const answerOf = (result: Record<string, unknown>): Record<string, unknown> | undefined => {
  const text = (result as TextResult).content?.[0]?.text
  if (result.success !== true || typeof text !== 'string') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export const createCodingSessionsDaemon = (input: {
  validateSessionAuthority?: CodingSessionsDaemon['validateSessionAuthority']
  pairingSource?: () => import('@nessie/executor-protocol').ExecutorSessionPairingSource | undefined
  connectionEpoch?: () => string | undefined
  executorId: string
  /**
   * The rules a call runs under, read as the call is stamped: a saved change
   * applies to the next call without a restart, and a launch the owner allowed
   * once reads the rules lent to it (`daemon-live-state.ts`).
   */
  commandRules: () => LocalCommandPolicy
  facts: ExecutorCodingSessionsFacts | undefined
  servers: readonly ExecutorLocalMcpServer[]
  sessions: ExecutorMcpSessionManager
  /**
   * Nessie has shown it reads requests on this connection
   * (`owner-requests-gate.ts`). Session hosts put provider prompts to the
   * owner only while it has and the reviewed facts say the owner answers them.
   */
  serverReadsRequests?: () => boolean
  log?: (message: string) => void
  now?: () => number
}): CodingSessionsDaemon => {
  const bridge = codingSessionsPolicyOf(input.facts, input.servers)?.server
  const bridgeConfig = bridge ? codingSessionsServerConfigPath(bridge) : undefined
  const bridgeStateDir = bridgeConfig ? join(dirname(bridgeConfig), 'coding-sessions') : undefined
  const changeMarker = bridgeStateDir ? codingSessionChangeMarker(bridgeStateDir) : undefined
  const writeAuthority = bridgeConfig && input.facts?.existingSessions
    ? existingAuthorityWriter(dirname(bridgeConfig)) : async () => undefined
  const writeOwnerRequests = bridgeStateDir ? ownerRequestsLeaseWriter(bridgeStateDir) : async () => undefined
  const ownerRequests = (): boolean => input.facts?.ownerAnswers === true && input.serverReadsRequests?.() === true
  const tellHosts = (live: boolean): void => { void writeOwnerRequests(live).catch(() => undefined) }
  // An earlier daemon's lease says nothing about the Nessie this one will meet.
  if (bridgeStateDir) tellHosts(false)
  const log = input.log ?? ((message: string) => { console.error(`[nessie-executor] ${message}`) })
  const owners = new Set<string>()
  let earlierSessionsMayExist = bridge !== undefined
  let queue: Promise<unknown> = Promise.resolve()
  const now = input.now ?? Date.now
  let failingSince: number | undefined
  const pending = new Map<string, ExecutorCodingSessionClose>()

  // Serialised, so a poll failure and a heartbeat failure in the same second
  // do not both find the registry non-empty and close everything twice.
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  const daemonCall = async (
    tool: string, args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> => {
    if (!bridge) return undefined
    const result = await input.sessions.callTool(bridge.name, tool, args, {
      [CODING_SESSION_DAEMON_CONTROL_META]: true,
      [CODING_SESSION_COMMAND_META]: `daemon-${randomUUID()}`,
    })
    const answer = answerOf(result)
    if (!answer) log(`the coding-sessions bridge did not complete ${tool}`)
    return answer
  }

  const closeAll = (reason: string): Promise<void> => serially(async () => {
    if (!bridge || (!earlierSessionsMayExist && owners.size === 0)) return
    const dispatched = [...owners]
    if (await daemonCall('session_close_all', { reason })) {
      earlierSessionsMayExist = false
      for (const owner of dispatched) owners.delete(owner)
    }
  })

  const sessionReport = async (tool: 'session_inventory' | 'session_list_all') => {
    const answer = await serially(() => daemonCall(tool, {}))
    if (!answer || !Array.isArray(answer.sessions)) return undefined
    return answer.sessions.flatMap((entry) => {
      const parsed = ExecutorCodingSessionSummarySchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    }).slice(0, EXECUTOR_CODING_SESSION_REPORT_MAXIMUM)
  }

  const viewerScope = async (request: ExecutorSessionViewRequest, phase: 'execute' | 'publish') => {
    if (input.pairingSource?.()?.kind === 'unbound_local') return undefined
    const scope = request.codingSessionAuthority
    if (!scope || !input.validateSessionAuthority || scope.operation !== 'session_view'
      || scope.ownerKey !== request.ownerKey || scope.admissions[0]?.sessionId !== request.sessionId) {
      throw new Error('Original viewer authority is unavailable')
    }
    return input.validateSessionAuthority(scope, phase)
  }

  return {
    // Only work this daemon started can be cut short by a restart; a Codex or
    // Claude conversation found already open belongs to its own client.
    isIdle: async () => !bridge || (await sessionReport('session_list_all'))?.every((session) =>
      session.origin === 'external' || ['closed', 'failed', 'interrupted'].includes(session.status)) === true,
    action: async (action) => {
      if (!bridge) return { id: action.id, state: 'outcome_unknown', code: 'delivery_unknown' }
      const { codingSessionAuthority, ...args } = action
      const answer = answerOf(await callSessionSurface({ sessions: input.sessions, server: bridge.name,
        tool: 'session_user_action', arguments: args, commandId: action.id, ownerKey: action.ownerKey,
        authority: codingSessionAuthority, source: () => input.pairingSource?.(),
        epoch: () => input.connectionEpoch?.(),
        validate: input.validateSessionAuthority }))
      const parsed = ExecutorSessionActionReceiptSchema.safeParse(answer?.receipt)
      return parsed.success ? parsed.data : { id: action.id, state: 'outcome_unknown', code: 'delivery_unknown' }
    },
    inventory: async (cursor) => {
      const answer = await serially(() => daemonCall('session_inventory', cursor ? { cursor } : {}))
      const parsed = ExecutorSessionInventoryPageSchema.safeParse(answer)
      return parsed.success ? parsed.data : undefined
    },
    conversation: async (request) => {
      const scope = await viewerScope(request, 'execute')
      if (!bridge) return null
      const result = await callSessionSurface({ sessions: input.sessions, server: bridge.name,
        tool: 'session_conversation', arguments: { sessionId: request.sessionId, ownerKey: request.ownerKey },
        commandId: scope?.commandId ?? `daemon-${randomUUID()}`, ownerKey: request.ownerKey, authority: scope,
        source: () => input.pairingSource?.(), epoch: () => input.connectionEpoch?.(),
        validate: input.validateSessionAuthority })
      await viewerScope(request, 'publish')
      const answer = answerOf(result)
      const parsed = ExecutorSessionConversationSchema.safeParse(answer?.conversation)
      return parsed.success ? parsed.data : null
    },
    validateSessionAuthority: async (scope, phase) => {
      if (!input.validateSessionAuthority) throw new Error('Original session authority check is unavailable')
      return input.validateSessionAuthority(scope, phase)
    },
    screen: async (request) => {
      const scope = await viewerScope(request, 'execute')
      if (request.ownerKey === EXISTING_CODING_SESSION_OWNER_KEY) {
        const answer = await daemonCall('existing_session_screen', request)
        const parsed = ExecutorSessionScreenSchema.safeParse(answer?.screen)
        return parsed.success ? parsed.data : null
      }
      const configPath = bridge ? codingSessionsServerConfigPath(bridge) : undefined
      if (!configPath) return null
      const loaded = await loadCodingSessionsConfig(configPath)
      if (loaded.digest !== input.facts?.configDigest) return null
      const paths = codingSessionPaths(loaded.stateDir, request.sessionId)
      const meta = await readSessionMeta(paths)
      if (!meta || meta.ownerKey !== request.ownerKey) return null
      if (scope) requireManagedSessionEvidence(scope, meta)
      const parsed = ExecutorSessionScreenSchema.safeParse(await readSessionScreen(paths, meta))
      await viewerScope(request, 'publish')
      return parsed.success ? parsed.data : null
    },
    callMeta: (server, call) => {
      if (!bridge || server !== bridge.name) return undefined
      const ownerKey = call.owner ? codingSessionOwnerKey(input.executorId, call.owner) : undefined
      if (ownerKey) owners.add(ownerKey)
      return {
        [CODING_SESSION_COMMAND_META]: call.commandId,
        [CODING_SESSION_COMMAND_RULES_META]: input.commandRules(),
        ...(input.pairingSource?.() ? { [CODING_SESSION_PAIRING_SOURCE_META]: input.pairingSource() } : {}),
        ...(input.connectionEpoch?.() ? { [CODING_SESSION_CONNECTION_META]: input.connectionEpoch() } : {}),
        ...(call.codingSessionAuthority ? { [CODING_SESSION_AUTHORITY_META]: call.codingSessionAuthority } : {}),
        ...(ownerKey ? { [CODING_SESSION_OWNER_META]: ownerKey } : {}),
      }
    },
    closeAll,
    connectionFailed: async (reason, error) => {
      const code = (error as { code?: unknown } | undefined)?.code
      failingSince ??= now()
      // A reconnect may meet a different Nessie; until it says `ready`, prompts are turned down.
      tellHosts(false)
      if (typeof code === 'string' && DEFINITIVE_FAILURES.has(code)) {
        await writeAuthority(false)
        await closeAll(reason)
      } else if (now() - failingSince >= DISCONNECT_CLOSE_MS) {
        await closeAll('connection_lost')
      }
    },
    connectionHealthy: (existingSessionsAllowed = false) => {
      failingSince = undefined
      void writeAuthority(existingSessionsAllowed).catch(() => undefined)
      tellHosts(ownerRequests())
    },
    ownerRequestsChanged: () => tellHosts(ownerRequests()),
    close: (instructions) => serially(async () => {
      if (!bridge) return
      // The heartbeat lists every close the API still has open, and absent
      // means none. One it no longer lists is done, a day old, or withdrawn by
      // the owner's relaunch — whose new session a retried owner-wide close
      // would end — so it is dropped, not retried. A list this daemon cannot
      // read changes nothing.
      const parsed = instructions === undefined
        ? { data: [], success: true as const }
        : ExecutorCodingSessionCloseListSchema.safeParse(instructions)
      if (parsed.success) {
        const listed = new Map<string, ExecutorCodingSessionClose>()
        for (const entry of parsed.data as ExecutorCodingSessionClose[]) {
          listed.set(`${entry.ownerKey}|${entry.sessionId ?? ''}`, entry)
        }
        for (const key of [...pending.keys()]) if (!listed.has(key)) pending.delete(key)
        for (const [key, entry] of listed) {
          if (pending.has(key) || pending.size < PENDING_CLOSE_MAXIMUM) pending.set(key, entry)
        }
      }
      for (const [key, entry] of pending) {
        const closed = await daemonCall('session_close_all', {
          ownerKey: entry.ownerKey, reason: entry.reason, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        })
        if (!closed) continue
        pending.delete(key)
        if (!entry.sessionId) owners.delete(entry.ownerKey)
      }
    }),
    shutdown: async () => {
      await writeAuthority(false)
      await writeOwnerRequests(false).catch(() => undefined)
      if (!bridge) return
      const configPath = codingSessionsServerConfigPath(bridge)
      const loaded = configPath ? await loadCodingSessionsConfig(configPath).catch(() => undefined) : undefined
      // A configuration that no longer matches its review cannot be trusted to
      // have opted out, so it is read as having opted in.
      const optedIn = loaded?.digest !== input.facts?.configDigest || loaded?.config.closeOnDaemonShutdown === true
      if (optedIn) await serially(async () => { await daemonCall('session_close_all', { reason: 'daemon_shutdown' }) })
    },
    report: () => sessionReport('session_list_all'),
    changeMarker: () => changeMarker,
    refreshExisting: async () => {
      if (!bridge || !input.facts?.existingSessions) return false
      const answer = await serially(() => daemonCall('existing_session_refresh', {})).catch(() => undefined)
      return answer?.changed === true
    },
  }
}
