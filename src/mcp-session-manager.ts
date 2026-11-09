import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { GuardedStdioTransport } from './mcp-host-execution.js'
import { createCodingProcessControl } from './coding-session/process-control.js'
import { cancelExecutorMcpProcessTree, stopExecutorMcpProcessTree } from './mcp-command-process.js'
import { isBuiltinCodingSessionsServer, isTrustedCodingControlBridge } from './coding-sessions-policy.js'
import { admitPersonalHostExecution } from './personal-host-execution.js'
import { PersonalInferenceGuard, type PersonalHostExecutionLease } from './personal-inference-guard.js'
import { classifyStartFailure, denied, failure, unavailable,
  startFailureMessage, type ExecutorMcpFailure } from './mcp-session-failure.js'
export type { ExecutorMcpFailure } from './mcp-session-failure.js'

import {
  EXECUTOR_MCP_CALL_TIMEOUT_MS,
  EXECUTOR_MCP_START_TIMEOUT_MS,
  type ExecutorMcpUnavailableReason,
} from '@nessie/executor-protocol'

import { loadExecutorMcpCatalog, executorMcpCatalogPage, PROBE_YIELDED, type SessionCatalog } from './mcp-session-catalog.js'
import { settleExecutorMcpImages, type ExecutorMcpImageSink } from './mcp-images.js'
import {
  ExecutorMcpServerError,
  findExecutorLocalMcpServer,
  type ExecutorLocalMcpServer,
} from './mcp-servers.js'

// The start and call timeouts are shared with the worker, which builds each
// mcp command's expiry from them (`@nessie/executor-protocol` executor-timing.ts): a
// start that may take ten seconds and a call that may take a minute both have
// to fit inside the command before it expires into an unknown outcome.
const MCP_SESSION_START_TIMEOUT_MS = EXECUTOR_MCP_START_TIMEOUT_MS
const MCP_CALL_TIMEOUT_MS = EXECUTOR_MCP_CALL_TIMEOUT_MS

/**
 * The longest this manager spends on one `mcp.tools` or `mcp.call` command:
 * a cold start, then one call deadline — a tool call, or the server's whole
 * tools/list walk, which shares a single deadline. A background probe steps
 * back behind a waiting command rather than add its own catalog read (up to
 * `MCP_PROBE_MAX_YIELDS` times). The worker's command expiry must cover this
 * plus uploads and the lane's hops; a test pins that it does.
 */
export const EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS = MCP_SESSION_START_TIMEOUT_MS + MCP_CALL_TIMEOUT_MS
// Sessions outlive single commands so a run's burst of tool calls reuses one
// process, but a bridge that keeps a server alive forever after one call
// leaks it; a minute of quiet retires the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 60_000
// A server that dies on every start must not be retried in a tight loop:
// after three consecutive start failures it sits out a minute.
const MCP_START_FAILURE_THRESHOLD = 3
const MCP_START_FAILURE_COOLDOWN_MS = 60_000
// The control plane caps a terminal command result at 64 KiB
// (executor-command-results.ts MAX_RESULT_BYTES). Images are out of the result
// before it is measured (`mcp-images.ts`): a Kelpie screenshot, three base64
// copies of up to a megabyte, used to be refused here every time. What is
// still over the cap is refused with a named code and its size rather than
// truncated, because truncated program output reads as a program bug instead
// of a stated limit.
const MCP_RESULT_MAX_BYTES = 65_536
// How many times one probe steps back for a command before it waits its turn.
const MCP_PROBE_MAX_YIELDS = 10



export type ExecutorMcpProbeOutcome =
  | {
    available: true
    catalogDigest: string
    serverVersion?: string
    toolCount: number
  }
  | {
    available: false
    reason: ExecutorMcpUnavailableReason
  }

export type ExecutorMcpSessionManager = {
  listTools: (
    server: string, cursor?: string, signal?: AbortSignal, authority?: unknown,
  ) => Promise<Record<string, unknown>>
  /**
   * `meta` becomes the request's `_meta`. Only the daemon sets it, and only
   * with the reserved keys a built-in bridge reads; a model never reaches it.
   * `images` keeps the call's images; without it they become placeholders.
   */
  callTool: (
    server: string,
    tool: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>,
    images?: ExecutorMcpImageSink,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>
  probe: (server: string) => Promise<ExecutorMcpProbeOutcome>
  stopAll: () => Promise<void>
}

type ActiveSession = {
  trustedCodingBridge: boolean
  protectionLease?: PersonalHostExecutionLease | null
  catalog?: SessionCatalog
  client: Client
  /** Commands waiting in `queue` that have not started yet. */
  commandsWaiting: number
  dead: boolean
  idleTimer?: NodeJS.Timeout
  pending: number
  /** Aborts the probe's tools/list in flight, when one is. */
  probeInFlight?: AbortController
  queue: Promise<void>
}

type StartFailure = {
  consecutive: number
  notBefore: number
}

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Owns one MCP client session per policy-named server. One session per server
 * — never per call, never per run: stdio is a single duplex that will not
 * tolerate interleaved misuse, so requests for a server serialize on its
 * session's queue while different servers proceed in parallel. Its start is
 * single-flight too: whoever finds no session waits on the one start in
 * flight rather than spawning a second process.
 */
export const createExecutorMcpSessionManager = (
  servers: readonly ExecutorLocalMcpServer[],
  limits: { maxResultBytes: number },
  options: {
    /** One tool call's deadline, and the whole catalog walk's; tests shorten it. */
    callTimeoutMs?: number
    idleTimeoutMs?: number
    log?: (message: string, cause: unknown) => void
    startCooldownMs?: number
    startTimeoutMs?: number
    personalGuard?: PersonalInferenceGuard
  } = {},
): ExecutorMcpSessionManager => {
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? MCP_SESSION_IDLE_TIMEOUT_MS
  const startCooldownMs = options.startCooldownMs ?? MCP_START_FAILURE_COOLDOWN_MS
  const startTimeoutMs = options.startTimeoutMs ?? MCP_SESSION_START_TIMEOUT_MS
  const log = options.log ?? ((message: string, cause: unknown) => {
    console.error(`[nessie-executor] ${message}:`, cause instanceof Error ? cause.message : String(cause))
  })
  const maxResultBytes = Math.min(limits.maxResultBytes, MCP_RESULT_MAX_BYTES)
  const personalGuard = options.personalGuard ?? PersonalInferenceGuard.open()
  const sessions = new Map<string, ActiveSession>()
  const transports = new Map<string, StdioClientTransport>()
  const processControl = createCodingProcessControl()
  // The one start in flight per server, which every caller that finds no
  // session shares (`sessionFor`).
  const starting = new Map<string, Promise<ActiveSession | ExecutorMcpUnavailableReason>>()
  // How many `stopAll` calls are under way: a start one of them did not see
  // would outlive it, so none begins meanwhile. A finished stop leaves the
  // manager usable, as the daemon's own suites rely on.
  let stopping = 0
  const startFailures = new Map<string, StartFailure>()

  const closeSession = async (server: string, session: ActiveSession): Promise<void> => {
    if (sessions.get(server) !== session) return Promise.resolve()
    const transport = transports.get(server) as GuardedStdioTransport | undefined
    sessions.delete(server)
    transports.delete(server)
    clearTimeout(session.idleTimer)
    session.dead = true
    try {
      if (session.protectionLease) {
        await stopExecutorMcpProcessTree(transport, processControl, transport?.processIdentity)
      }
    } finally { await session.client.close().catch(() => undefined) }
    await session.protectionLease?.release()
  }

  const armIdleTimer = (server: string, session: ActiveSession): void => {
    if (session.dead || session.pending > 0) return
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      void closeSession(server, session).catch(() => log('MCP process termination could not be confirmed.', undefined))
    }, idleTimeoutMs)
  }

  const noteStartFailure = (server: string): void => {
    const previous = startFailures.get(server)
    const consecutive = (previous?.consecutive ?? 0) + 1
    startFailures.set(server, {
      consecutive,
      notBefore: consecutive >= MCP_START_FAILURE_THRESHOLD
        ? Date.now() + startCooldownMs
        : 0,
    })
  }

  const startSession = async (
    spec: ExecutorLocalMcpServer,
    authority?: unknown,
  ): Promise<ActiveSession | ExecutorMcpUnavailableReason> => {
    const backoff = startFailures.get(spec.name)
    if (backoff && backoff.notBefore > Date.now()) {
      return 'handshake_failed'
    }
    const protectionLease = isTrustedCodingControlBridge(spec) ? null
      : await admitPersonalHostExecution(`stdio-mcp:${spec.name}`, authority, personalGuard)
    const client = new Client(
      { name: 'nessie-executor', version: '1' },
      { capabilities: {} },
    )
    const transport = new GuardedStdioTransport({
      args: spec.command.slice(1),
      command: spec.command[0] ?? '',
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      // The transport layers this over its safe default set (PATH, HOME, …),
      // so a server gets only the environment the policy spells out.
      ...(spec.env === undefined ? {} : { env: spec.env }),
      stderr: 'inherit',
    }, processControl, protectionLease)
    transports.set(spec.name, transport)
    let spawnError: (Error & { code?: string }) | undefined
    let exited = false
    transport.onerror = (error: Error) => {
      spawnError ??= error
    }
    transport.onclose = () => {
      exited = true
    }
    const session: ActiveSession = {
      trustedCodingBridge: isTrustedCodingControlBridge(spec),
      protectionLease,
      client,
      commandsWaiting: 0,
      dead: false,
      pending: 0,
      queue: Promise.resolve(),
    }
    client.onclose = () => {
      // A crash is noticed here: the session is dropped, its in-flight call
      // has already been rejected by the SDK, and the next request starts a
      // fresh process — subject to the crash-loop cooldown.
      if (sessions.get(spec.name) === session) {
        void closeSession(spec.name, session).catch(() => log('MCP process termination could not be confirmed.', undefined))
      }
    }
    try {
      await withTimeout(client.connect(transport), startTimeoutMs)
    } catch (error) {
      const reason = classifyStartFailure(spawnError, exited)
      log(`local MCP server "${spec.name}" failed to start (${reason})`, error)
      noteStartFailure(spec.name)
      // The transport is closed as well as the client. A connect that never
      // completed leaves the client with no transport to close, so closing
      // only the client leaks the pipe — which keeps the daemon's event loop
      // alive forever after a server that will not start.
      // ENOENT with no pid is positive no-spawn evidence, unlike natural EOF.
      // The SDK exposes an absent POSIX child as null. On Windows an already
      // exited shell wrapper can also lose its pid; that is not no-spawn proof.
      if (protectionLease && process.platform !== 'win32'
        && (spawnError?.code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOENT')
        && (transport.pid === undefined || transport.pid === null) && transport.processIdentity === undefined) {
        await protectionLease.release()
      } else if (protectionLease) {
        try {
          await stopExecutorMcpProcessTree(transport, processControl, transport.processIdentity)
          await protectionLease.release()
        } catch { /* Persist the admission when termination is unknown. */ }
      }
      await Promise.allSettled([client.close(), transport.close()])
      if (transports.get(spec.name) === transport) transports.delete(spec.name)
      return reason
    }
    startFailures.delete(spec.name)
    sessions.set(spec.name, session)
    return session
  }

  /**
   * The server's live session, or the start every caller that found none
   * shares. The reporter's probe and a command that both arrived at a cold
   * server once started a process each; the later one replaced the earlier in
   * `sessions`, and the earlier's idle close then looked itself up, found the
   * other, and closed nothing — a process per race, running until the daemon
   * stopped. A shared start also counts one failure, not one per caller.
   */
  const sessionFor = (
    spec: ExecutorLocalMcpServer, authority?: unknown,
  ): Promise<ActiveSession | ExecutorMcpUnavailableReason> => {
    const live = sessions.get(spec.name)
    if (live && !live.dead) return Promise.resolve(live)
    let started = starting.get(spec.name)
    if (!started) {
      started = startSession(spec, authority).finally(() => starting.delete(spec.name))
      starting.set(spec.name, started)
    }
    return started
  }

  /**
   * Runs `work` as the one in-flight request on the server's session. The
   * policy check happens here — before any process starts — so no path to a
   * session can reach a server the reviewed policy did not name.
   *
   * A command's work cancels a probe's tools/list in flight on the same
   * session, so the probe steps back behind it (`probe`). A command's expiry
   * budgets a cold start and its own call, nothing for the reporter's
   * background probe, which once held the queue for a whole tools/list.
   */
  const withSession = async <T>(
    server: string,
    work: (session: ActiveSession) => Promise<T>,
    options: { probe?: boolean; signal?: AbortSignal; authority?: unknown } = {},
  ): Promise<T | ExecutorMcpFailure> => {
    let spec: ExecutorLocalMcpServer
    try {
      spec = findExecutorLocalMcpServer(servers, server)
    } catch (error) {
      return denied(error as ExecutorMcpServerError)
    }
    // A cached process is no exception: every call and passive catalogue read
    // must still name eligible private authority once protection is active.
    if (!isTrustedCodingControlBridge(spec)) await personalGuard.assertExecutionAuthority(options.authority)
    if (stopping > 0) return unavailable(`The MCP server "${server}" is not started: this team is stopping.`, 'not_probed')
    options.signal?.throwIfAborted()
    let teardown: Promise<void> | undefined
    const cancel = (): void => {
      teardown ??= Promise.resolve().then(async () => {
        const transport = transports.get(server) as GuardedStdioTransport | undefined
        // The built-in bridge's detached hosts are durable sessions, owned
        // by their separate leases, not by this request's control process.
        // Closing that bridge must retain the host lifetime contract.
        if (!isBuiltinCodingSessionsServer(spec)) {
          await cancelExecutorMcpProcessTree(transport, processControl, transport?.processIdentity)
        }
        const current = sessions.get(server)
        if (current && transports.get(server) === transport) await closeSession(server, current)
        else await transport?.close()
      })
      void teardown.catch(() => undefined)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const active = await sessionFor(spec, options.authority)
      if (options.signal?.aborted) {
        cancel()
        options.signal.throwIfAborted()
      }
      if (typeof active === 'string') return unavailable(startFailureMessage(server, active), active)
      clearTimeout(active.idleTimer)
      active.pending += 1
      const command = options.probe !== true
      if (command) {
        active.commandsWaiting += 1
        active.probeInFlight?.abort()
      }
      const run = active.queue.then(() => {
        if (command) active.commandsWaiting -= 1
        options.signal?.throwIfAborted()
        return work(active)
      })
      active.queue = run.then(() => undefined, () => undefined)
      try {
        return await run
      } finally {
        active.pending -= 1
        armIdleTimer(server, active)
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      await teardown
    }
  }


  return {
    listTools: (server, cursor, signal, authority) => withSession(server, async (session) => {
      const catalog = await loadExecutorMcpCatalog(session, server, callTimeoutMs, log)
      // Unreachable: only a probe passes the signal that yields.
      if (catalog === PROBE_YIELDED) return failure('EXECUTOR_MCP_UNAVAILABLE', 'The catalog read was interrupted.')
      if ('code' in catalog) return catalog
      return executorMcpCatalogPage(catalog, cursor, maxResultBytes)
    }, { signal, authority }),
    callTool: (server, tool, args, meta, images, signal) => withSession(server, async (session) => {
      // Custody metadata is consumed by admission. Custom programs receive
      // their tool arguments, not the owner's private run/identity projection.
      const requestMeta = meta === undefined ? undefined : { ...meta }
      if (requestMeta && !session.trustedCodingBridge) delete requestMeta['nessie/personal-authority']
      let result
      try {
        result = await session.client.callTool(
          {
            name: tool,
            ...(args === undefined ? {} : { arguments: args }),
            ...(requestMeta === undefined ? {} : { _meta: requestMeta }),
          },
          undefined,
          // Cancellation tears down the process tree before closing the
          // transport; sending an MCP abort first could let its root exit
          // and hide descendants before their identities were captured.
          { timeout: callTimeoutMs },
        )
      } catch (error) {
        if (session.dead) {
          log(`local MCP server "${server}" died during tools/call`, error)
          return unavailable(`The MCP server "${server}" stopped during the call.`)
        }
        log(`local MCP server "${server}" failed tools/call`, error)
        return failure(
          'EXECUTOR_MCP_CALL_FAILED',
          `The MCP server "${server}" refused the call to "${tool}".`,
        )
      }
      // The images leave first, into the sink's keeping, so what is measured
      // below is the result that will be journaled and sent.
      const settled = await settleExecutorMcpImages(result as Record<string, unknown>, images, log)
      const document: Record<string, unknown> = settled.isError === true
        ? { ...settled, code: 'EXECUTOR_MCP_CALL_FAILED', success: false }
        : { ...settled, success: true }
      // Measured as it is returned, `code` and `success` included. An isError
      // result measured before its code was added could pass here, be refused
      // by the control plane's own cap, and leave the receipt nowhere to go.
      const resultBytes = Buffer.byteLength(JSON.stringify(document))
      // Viewer history never becomes an agent tool result or enters the command journal.
      const resultBudget = session.trustedCodingBridge && meta?.['nessie/daemon-control'] === true
        && tool === 'session_conversation' ? 1024 * 1024 : maxResultBytes
      if (resultBytes > resultBudget) {
        return {
          code: 'EXECUTOR_MCP_RESULT_TOO_LARGE',
          maxResultBytes: resultBudget,
          message: `The MCP server "${server}" answered with ${resultBytes} bytes, over the ${resultBudget}-byte result budget.`,
          resultBytes,
          success: false,
        }
      }
      return document
    }, { signal, authority: meta?.['nessie/personal-authority'] }),
    probe: async (server) => {
      // A probe goes behind every command that is waiting or arrives while it
      // reads the catalog, a bounded number of times; a catalog already read
      // answers at once and never needs to.
      let outcome: SessionCatalog | ExecutorMcpFailure | typeof PROBE_YIELDED = PROBE_YIELDED
      for (let attempt = 0; outcome === PROBE_YIELDED; attempt += 1) {
        const mayYield = attempt < MCP_PROBE_MAX_YIELDS
        outcome = await withSession(server, async (session) => {
          if (session.catalog) return session.catalog
          if (mayYield && session.commandsWaiting > 0) return PROBE_YIELDED
          const controller = new AbortController()
          session.probeInFlight = controller
          try {
            return await loadExecutorMcpCatalog(
              session, server, callTimeoutMs, log, mayYield ? controller.signal : undefined,
            )
          } finally {
            session.probeInFlight = undefined
          }
        }, { probe: true })
      }
      if ('code' in outcome) {
        if (outcome.code === 'EXECUTOR_MCP_DENIED') return { available: false, reason: 'not_probed' as const }
        // A start failure already decided why; only a server that started and
        // then refused tools/list is a handshake failure.
        return { available: false, reason: outcome.reason ?? 'handshake_failed' }
      }
      return {
        available: true,
        catalogDigest: outcome.digest,
        ...(outcome.content.serverVersion === undefined
          ? {}
          : { serverVersion: outcome.content.serverVersion }),
        toolCount: outcome.content.tools.length,
      }
    },
    stopAll: async () => {
      // Nothing starts while a stop is under way, and a start already in
      // flight finishes first — within its start timeout — so the process it
      // opens is closed with the rest instead of outliving the stop on an idle
      // timer nobody waits for.
      stopping += 1
      try {
        while (starting.size > 0) await Promise.allSettled([...starting.values()])
        const active = [...sessions.entries()]
        await Promise.all(active.map(([server, session]) => closeSession(server, session)))
      } finally {
        stopping -= 1
      }
    },
  }
}
