import { claimHostEffect, recordHostEffectAccepted } from './host-effect-intent.js'
import { SessionEffectRefused, type SessionEffectAuthority } from './session-effect-authority.js'
import { requestEffectAuthority } from './session-effect-authority.js'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'

import { buildAgentEnvironment } from './agent-env.js'
import { createHostProcessControl } from './agent-guard.js'
import { AgentStartError, type AgentDriver } from './agent-process.js'
import { createClaudeDriver } from './claude-driver.js'
import { codexAccountRedactions, createCodexDriver } from './codex-driver.js'
import {
  codingSessionsDigestMatches,
  loadCodingSessionsConfig,
  type CodingAgentConfig,
  type LoadedCodingSessionsConfig,
} from './config.js'
import { ensureCodingSessionHost, executorRuntimeDigest, resolveExecutorEntry } from './host-spawn.js'
import { stopOwnUserUnit } from './host-unit.js'
import type { CodingProcessControl } from './process-control.js'
import { resolveProgramPath } from './program-path.js'
import { createProjector, SECRET_NAME, type Projector } from './projection.js'
import { gitStartSnapshot } from './review.js'
import { findCodingRoot, resolveCodingFolder, resolveCodingRoots } from './roots.js'
import { runCodingSelfCheck, runsUnderWindowsService } from './self-check.js'
import { createTerminalDriver } from './terminal-driver.js'
import { openEventLog } from './session-events.js'
import {
  codingAgentHelpCache,
  codingSessionPaths,
  createDebouncedJsonWriter,
  readJson,
  readJsonFile,
  type CodingSessionPaths,
} from './session-files.js'
import { acquireHostLock, HOST_HEARTBEAT_MS, type HeldHostLock } from './session-lock.js'
import { inboxHasRequests, listRequests, readSessionMeta, removeRequest } from './session-requests.js'
import { markCodingSessionChanged } from './session-change-marker.js'
import { ownerRequestsLeaseIsLive } from './owner-requests-lease.js'
import { createAnswerKey } from './answer-seal.js'
import { restoreSecretRedactions, unsealHostAnswer } from './secret-redactions.js'
import { SessionRequestBook } from './session-request-book.js'
import { readSessionRequests, writeSessionRequests } from './session-request-file.js'
import { createSecretAskWatcher } from './session-secret-asks.js'
import { sessionSecretServer } from './session-secret-server.js'
import {
  initialCodingSessionState,
  type CodingEventBody,
  type CodingSessionMeta,
  type CodingSessionRequest,
  type CodingSessionState,
} from './types.js'

/**
 * `nessie-executor coding-session-host --config <path> --session <id>`: the
 * detached process that owns one session's coding agent and all of its state.
 *
 * It takes the session's lock, acts on inbox requests in order, and exits once
 * no agent is alive and nothing is left to do — removing its lock and then
 * looking at the inbox once more, so a request written in that instant is
 * never stranded. A host that finds its lock taken over exits at once without
 * writing anything, and every host kills a previous host's still-running agent
 * before it starts or resumes one of its own.
 *
 * When the reviewed config digest no longer matches the file, a host still
 * processes interrupts and closes (which only stop things) but refuses to start
 * or resume an agent.
 */

const POLL_MS = 300
const MAX_LOG_BYTES = 1024 * 1024
const INTERRUPT_GRACE_MS = 30_000

/**
 * What the next host needs if this one dies: which agent process to kill and
 * which agent session to resume. These skip the debounce and are written at
 * once: a host killed inside the 500 ms window otherwise left the next one a
 * `working` session with no confirmed agent session, so it started the agent
 * afresh instead of resuming it (seen on Windows under load).
 */
const RECOVERY_FIELDS = ['agentIdentity', 'agentSessionId', 'agentSessionStarted'] as const

type HostContext = {
  control: CodingProcessControl
  loaded: LoadedCodingSessionsConfig
  meta: CodingSessionMeta
  paths: CodingSessionPaths
  projector: Projector
  log: (message: string) => void
  mayRunAgent: boolean
  roots: Awaited<ReturnType<typeof resolveCodingRoots>>
}

class HostSuperseded extends Error {}

/** A terminal runs the command its start recorded, which the command rules permitted, in its own folder. */
const terminalAgentOf = (meta: CodingSessionMeta): CodingAgentConfig | undefined => (
  meta.command?.length ? { command: meta.command, args: [], allowedTools: [], disallowedTools: [] } : undefined
)

const terminalFolderOf = async (meta: CodingSessionMeta): Promise<string> => {
  if (meta.cwd && await stat(meta.cwd).then((info) => info.isDirectory(), () => false)) return meta.cwd
  throw new AgentStartError('cwd_unavailable')
}

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

const hostLogger = (): ((message: string) => void) => {
  let written = 0
  return (message) => {
    if (written > MAX_LOG_BYTES) return
    const line = `${new Date().toISOString()} ${message}\n`
    written += line.length
    process.stderr.write(written > MAX_LOG_BYTES ? 'host log limit reached\n' : line)
  }
}

/** How a host's time with the lock ended. */
type ServeOutcome = 'finished' | 'retired' | 'superseded'

/** Serves the session while this host holds the lock. */
const serveSession = async (context: HostContext, lock: HeldHostLock): Promise<ServeOutcome> => {
  const { control, loaded, meta, paths, log } = context
  const read = await readJsonFile<CodingSessionState>(paths.state)
  // A state file that exists but cannot be read is not a new session: starting
  // afresh would erase its agent session, its turn and its review baseline.
  if (read.found === 'unreadable') throw new Error('The session state exists but cannot be read.')
  const previous = read.found === 'yes' ? read.value : undefined
  const state: CodingSessionState = previous?.version === 1
    ? previous
    : initialCodingSessionState(new Date().toISOString())
  const writer = createDebouncedJsonWriter(paths.state, () => state, log, undefined, lock.stillOurs)
  const position = { generation: state.eventsGeneration, lastSeq: state.lastSeq }
  const events = await openEventLog(paths, position, (next) => {
    state.eventsGeneration = next.generation
    state.lastSeq = next.lastSeq
    // A reader that took the old generation for the new file would deliver its events twice.
    if (next.rotated) void writer.flush()
    else writer.schedule()
  })
  const emit = (body: CodingEventBody): void => {
    void events.append(body).catch((error: unknown) => log(`event append failed: ${String(error)}`))
  }
  const update = (patch: Partial<CodingSessionState>): void => {
    const before = state.status
    Object.assign(state, patch)
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (state as Record<string, unknown>)[key]
    }
    // Confirmed, or answered: from here on the agent's own transcript holds the first message.
    if (patch.agentSessionStarted === true || patch.lastResult !== undefined) delete state.firstPrompt
    state.updatedAt = new Date().toISOString()
    // Every way a turn ends leaves `working`, so the end is recorded here rather than by each of them.
    if (before === 'working' && state.status !== 'working') state.lastTurnEndedAt = state.updatedAt
    if (patch.status && patch.status !== before) {
      emit({ kind: 'system', subtype: 'status', status: patch.status, ...(state.reason ? { reason: state.reason } : {}) })
      // On disk at once, then the daemon is told: it reports the change within a quarter second.
      void writer.flush().then(() => markCodingSessionChanged(loaded.stateDir, meta.sessionId))
    } else if (RECOVERY_FIELDS.some((key) => key in patch)) void writer.flush()
    else writer.schedule()
  }

  // What the agent waits on its owner for. A change is written at once and announced like a status
  // change; the time a turn spends waiting on its owner never counts against its turn limit.
  let requestWrites: Promise<unknown> = Promise.resolve()
  let waitingSince: number | undefined
  // Whether the daemon says Nessie can put a prompt to the owner now; re-read every second.
  let ownerReachable = await ownerRequestsLeaseIsLive(loaded.stateDir)
  let reachableReadAt = Date.now()
  // What the owner types in secret reaches this host sealed to a key only it holds (`answer-seal.ts`).
  const answerKey = createAnswerKey()
  const book = new SessionRequestBook((list) => {
    requestWrites = requestWrites.then(async () => {
      if (await lock.stillOurs()) await writeSessionRequests(paths, list, answerKey.publicKey)
      await markCodingSessionChanged(loaded.stateDir, meta.sessionId)
    }).catch((error: unknown) => log(`requests write failed: ${String(error)}`))
    const waiting = list.some((request) => request.status === 'pending')
    if (waiting) waitingSince ??= Date.now()
    else if (waitingSince !== undefined) {
      const waited = Date.now() - waitingSince
      waitingSince = undefined
      const startedAt = state.turnStartedAt
      if (startedAt) update({ turnStartedAt: new Date(Date.parse(startedAt) + waited).toISOString() })
    }
    // The session changed, so it leads the next inventory page.
    if (waiting) update({})
  }, await readSessionRequests(paths, true), () => ownerReachable)
  // Values the owner supplied earlier stay `<secret>` in whatever this host's agent says.
  if (meta.agent !== 'terminal' && context.mayRunAgent) {
    const folder = await resolveCodingFolder(findCodingRoot(context.roots, meta.rootName), meta.path)
      .catch(() => undefined)
    if (folder) await restoreSecretRedactions(paths, folder, context.projector, log)
  }

  // A previous host died mid-turn: say so, and stop its agent before anything else runs.
  if (previous && (state.status === 'working' || state.status === 'starting') && state.turn > 0) {
    update({ status: 'interrupted', reason: 'host_lost', turnStartedAt: undefined })
  }
  // An agent session id the agent never confirmed may or may not exist: Claude
  // creates it on the first message, and refuses `--session-id` for an id it
  // already has. So an unconfirmed id is dropped and the next agent starts
  // afresh — given the first message again (`deliver`), which the lost one took with it.
  if (state.agentIdentity) {
    log('stopping the previous host\'s agent')
    await control.killTree(state.agentIdentity)
    update({ agentIdentity: undefined })
  }
  if (state.agentSessionId !== undefined && state.agentSessionStarted !== true) update({ agentSessionId: undefined })

  let driver: AgentDriver | undefined
  let retiring = false
  let superseded = false
  /** An interrupt still waiting for its turn to end, and which turn that is. */
  let pendingInterrupt: { at: number; turn: number; reason?: string } | undefined
  const prepare = async (): Promise<AgentDriver> => {
    if (driver) return driver
    if (!await lock.stillOurs()) throw new AgentStartError('host_superseded')
    const terminal = meta.agent === 'terminal'
    // A terminal has no CLI to probe, but meets the supervisor refusal the coding agents' self-check starts with.
    if (terminal && await runsUnderWindowsService()) throw new AgentStartError('unsupported_supervisor')
    // An older build's configured terminal program is never run: a terminal runs what its start recorded.
    const configured = terminal ? terminalAgentOf(meta) : loaded.config.agents[meta.agent]
    if (!configured) throw new AgentStartError(terminal ? 'terminal_command_missing' : 'agent_unavailable')
    const folder = terminal ? await terminalFolderOf(meta)
      : await resolveCodingFolder(findCodingRoot(context.roots, meta.rootName), meta.path)
        .catch(() => { throw new AgentStartError('root_unavailable') })
    const env = await buildAgentEnvironment({ config: loaded.config.agentEnv })
    // What the host hands the agent as a credential never comes back out in its events.
    context.projector.redactSecrets([
      ...Object.values(loaded.config.agentEnv.set),
      ...Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value),
    ])
    if (meta.agent === 'codex') context.projector.redact(await codexAccountRedactions(env))
    // Once, from the absolute PATH entries only: every probe, the help cache and every agent start run this
    // path, never a program of the same name in the session's folder (`program-path.ts`).
    const program = await resolveProgramPath(configured.command[0]!, env)
    if (program === undefined) throw new AgentStartError('agent_missing')
    const agent = { ...configured, command: [program, ...configured.command.slice(1)] }
    const check = terminal ? { ok: true as const } : await runCodingSelfCheck({
      agent: meta.agent, config: agent, cwd: folder, env, helpCacheFile: codingAgentHelpCache(loaded.stateDir),
      ...(loaded.config.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: loaded.config.maxBudgetUsd }),
    })
    if (!check.ok) {
      const named = check.missing?.slice(0, 10).join(', ')
      if (named) log(check.reason === 'agent_help_unreadable' ? `the agent's help did not answer: ${named}` : `the agent's --help does not offer ${named}`)
      throw new AgentStartError(check.reason)
    }
    if (check.unverified) log(`the agent's --help lists no choices this host can read for ${check.unverified.join(', ')}; not checked`)
    if (check.agentVersion) update({ agentVersion: context.projector.line(check.agentVersion, 80) })
    // A review baseline is for the coding agents; a terminal has no review.
    if (!terminal && state.baseCommit === undefined && state.worktreesAtStart === undefined) {
      update(await gitStartSnapshot(folder))
    }
    const driverContext = {
      requests: book, secretServer: sessionSecretServer(paths),
      roots: context.roots.roots.flatMap((root) => [root.declared, ...(root.canonical ? [root.canonical] : [])]),
      personalAuthority: meta.personalAuthority,
      agent, control, env, folder, paths, projector: context.projector, log, emit, update, state: () => state,
      stillOwner: lock.stillOurs,
      ...(loaded.config.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: loaded.config.maxBudgetUsd }),
    }
    driver = terminal ? createTerminalDriver(driverContext)
      : meta.agent === 'claude' ? createClaudeDriver(driverContext) : createCodexDriver(driverContext)
    return driver
  }

  const deliver = async (text: string, kind: 'start' | 'send', effect?: SessionEffectAuthority): Promise<void> => {
    if (!context.mayRunAgent) {
      emit({ kind: 'system', subtype: 'refused', reason: 'config_changed' })
      if (!state.agentSessionStarted) update({ status: 'failed', reason: 'config_changed' })
      return
    }
    // Until the agent confirms its session, every message it was given stays in the state. A send
    // that finds no agent running any more carries them first: the agent that had them never
    // confirmed its session, so they went with it. A start delivered again (its host died before it
    // left the inbox) is that first message itself, never a second copy of it.
    const unconfirmed = meta.agent !== 'terminal' && state.agentSessionStarted !== true
    const held = !effect && kind === 'send' && unconfirmed ? state.firstPrompt : undefined
    const lost = held !== undefined && !driver?.running()
    if (lost) log('sending the earlier messages again: the agent that had them never confirmed its session')
    const message = lost ? `${held}\n\n${text}` : text
    // However many agents are lost before one confirms, the next gets all of it.
    if (unconfirmed && !effect) update({ firstPrompt: held === undefined ? text : `${held}\n\n${text}` })
    try {
      await (await prepare()).send(message, randomUUID(), effect)
    } catch (error) {
      if (error instanceof SessionEffectRefused) throw error
      const reason = error instanceof AgentStartError ? error.reason : 'agent_exited'
      if (reason === 'host_superseded') throw new HostSuperseded()
      log(`the agent could not start: ${reason}`)
      if (meta.agent === 'terminal' && !(error instanceof AgentStartError)) log(String(error))
      emit({ kind: 'system', subtype: 'agent_failed', reason })
      update({ status: state.agentSessionStarted ? 'interrupted' : 'failed', reason, turnStartedAt: undefined })
    }
  }

  const handle = async (request: CodingSessionRequest): Promise<void> => {
    const effect = requestEffectAuthority(dirname(loaded.configPath), meta, request)
    await effect?.consume()
    effect?.assertLive()
    const intent = effect ? await claimHostEffect(paths, request, effect) : undefined
    if (request.kind === 'retire') {
      retiring = true
    } else if (request.kind === 'answer') {
      const answer = request.answer && unsealHostAnswer(request.answer, answerKey, context.projector)
      // Sealed for a key this host does not hold: nothing can deliver it, so the request ends rather than waits.
      if (request.answer && !answer) await book.withdraw(request.answer.requestId, 'expired', 'answer_unreadable')
      const problem = answer ? await book.answer(answer, effect) : 'answer_shape_mismatch'
      if (problem) log(`an answer was not delivered: ${problem}`)
    } else if (request.kind === 'close') {
      await book.withdrawAll('cancelled', 'session_closed')
      // The daemon's close carries its categorical reason; an owner's carries none.
      if (driver) await driver.close(request.reason, effect)
      else update({ status: 'closed', reason: request.reason, turnStartedAt: undefined })
    } else if (request.kind === 'interrupt') {
      await book.withdrawAll('cancelled', 'turn_interrupted')
      await driver?.interrupt(undefined, effect)
      // Ctrl-C is a key the terminal's program handles as it likes: a shell stays open, so it never ends one.
      if (driver?.busy() && meta.agent !== 'terminal') pendingInterrupt ??= { at: Date.now(), turn: state.turn }
    } else if (state.status === 'closed' || state.status === 'failed') {
      emit({ kind: 'system', subtype: 'ignored', reason: state.status })
    } else if (request.kind === 'start' && state.turn > 0) {
      // A start this session already acted on (a replay the bridge let through); nothing to do.
    } else if (request.kind === 'start' || request.kind === 'send') {
      await deliver(request.text ?? '', request.kind, effect)
    }
    if (intent) await recordHostEffectAccepted(intent, request.id)
  }

  // `request_secret` calls the agent made, turned into requests for the owner.
  const secretAsks = meta.agent === 'terminal' ? undefined : createSecretAskWatcher({
    paths, requests: book, projector: context.projector, log,
    interrupt: () => { void driver?.interrupt() },
  })
  await secretAsks?.prepare()

  const heartbeat = setInterval(() => {
    void (async () => {
      if (await lock.heartbeat().catch(() => true)) return
      // Another host owns the session now. Stop our agent and leave without writing.
      superseded = true
      const identity = state.agentIdentity
      if (driver) await driver.endIdle()
      else if (identity) await control.killTree(identity)
      process.exit(0)
    })().catch((error: unknown) => log(`heartbeat failed: ${String(error)}`))
  }, HOST_HEARTBEAT_MS)

  // Checked between requests, never beside one, so ending an idle agent cannot race a follow-up.
  // A turn past maxTurnMinutes is interrupted. Any interrupt whose turn has
  // still not ended a grace later (30 s, or the turn limit when that is
  // shorter) ends the agent process instead — an agent that ignores it, or a
  // message the CLI dropped, never keeps a session working — and the session
  // stays resumable. A terminal has no turns: it starts none, so neither
  // limit applies, and it ends when its program exits or the session closes.
  const enforceLimits = async (): Promise<void> => {
    const now = Date.now()
    const limitMs = loaded.config.maxTurnMinutes * 60_000
    if (pendingInterrupt) {
      // A new turn is not the one interrupted; a follow-up folded into that one is.
      if (!driver?.busy() || state.turn !== pendingInterrupt.turn) {
        pendingInterrupt = undefined
      } else if (now - pendingInterrupt.at > Math.min(INTERRUPT_GRACE_MS, limitMs)) {
        const { reason } = pendingInterrupt
        pendingInterrupt = undefined
        emit({ kind: 'system', subtype: 'interrupt_ignored', ...(reason ? { reason } : {}) })
        await driver.endIdle()
        update({ status: 'interrupted', reason, turnStartedAt: undefined })
      }
      return
    }
    if (driver?.busy() && state.turnStartedAt && waitingSince === undefined
      && now - Date.parse(state.turnStartedAt) > limitMs) {
      emit({ kind: 'system', subtype: 'limit', reason: 'max_turn_minutes' })
      update({ turnStartedAt: undefined })
      pendingInterrupt = { at: now, turn: state.turn, reason: 'max_turn_minutes' }
      await driver.interrupt('max_turn_minutes')
    } else if (driver?.running() && !driver.busy()
      && now - Date.parse(state.updatedAt) > loaded.config.idleMinutes * 60_000) {
      log('ending the idle agent')
      await driver.endIdle()
    }
  }

  let served = false
  try {
    for (;;) {
      const requests = await listRequests(paths)
      // Everything after a close is still consumed: a send there is reported ignored, not left waiting.
      for (const request of requests) {
        await handle(request)
        // What the request changed — a new turn, a queued message — is on disk
        // before it leaves the inbox, so a read that finds the inbox empty
        // never finds the state from before it and takes the old turn's end
        // for the answer.
        await writer.flush()
        await removeRequest(paths, request.id)
      }
      if (Date.now() - reachableReadAt >= 1_000) {
        ownerReachable = await ownerRequestsLeaseIsLive(loaded.stateDir)
        reachableReadAt = Date.now()
      }
      await secretAsks?.poll()
      if (!served) {
        // This host has served, so the bridge's count of hosts that died before serving starts again.
        served = true
        await unlink(paths.spawnMarker).catch(() => undefined)
      }
      if (state.status === 'closed' || superseded) break
      if (retiring && !driver?.busy()) break
      if (requests.length === 0 && !driver?.running() && !driver?.busy()) break
      if (requests.length === 0) await enforceLimits()
      await delay(POLL_MS)
    }
    if (retiring && driver?.running()) await driver.endIdle()
  } catch (error) {
    if (!(error instanceof HostSuperseded)) throw error
    superseded = true
  } finally {
    clearInterval(heartbeat)
    await events.close()
    // Nothing is left to answer what is still pending once this host stops serving.
    try { if (!superseded) await book.withdrawAll('expired', 'provider_exited') }
    finally {
      await requestWrites
      if (!superseded) await writer.flush()
    }
  }
  return superseded ? 'superseded' : retiring ? 'retired' : 'finished'
}

export const runCodingSessionHost = async (input: { configPath: string; sessionId: string }): Promise<void> => {
  const log = hostLogger()
  const loaded = await loadCodingSessionsConfig(input.configPath)
  const paths = codingSessionPaths(loaded.stateDir, input.sessionId)
  const meta = await readSessionMeta(paths)
  if (!meta) {
    log('no such session')
    return
  }
  const mayRunAgent = codingSessionsDigestMatches(loaded)
  // Roots nobody reviewed are never resolved; a host under a changed file only stops things.
  const roots = await resolveCodingRoots(mayRunAgent ? loaded : { ...loaded, config: { ...loaded.config, roots: [] } })
  if (!mayRunAgent) log('the configuration no longer matches its reviewed digest; agents will not start')
  const entry = resolveExecutorEntry()
  const context: HostContext = {
    control: createHostProcessControl(entry, { log }),
    loaded, meta, paths, log, mayRunAgent, roots,
    projector: createProjector(roots.rewriter),
  }
  const runtimeDigest = await executorRuntimeDigest(entry)
  for (;;) {
    const lock = await acquireHostLock(paths.lock, runtimeDigest)
    if (!lock) return
    let outcome: ServeOutcome
    try {
      outcome = await serveSession(context, lock)
    } finally {
      await lock.release()
    }
    if (outcome === 'finished' && await inboxHasRequests(paths)) continue
    if (outcome === 'retired' && await inboxHasRequests(paths)) {
      // This host runs older code. A request that arrived behind the retirement
      // goes to a successor started from the entry as it is installed now.
      const pending = (await listRequests(paths)).find(request => request.kind !== 'retire')
      if (!pending) return
      const effect = requestEffectAuthority(dirname(loaded.configPath), meta, pending)
      await ensureCodingSessionHost({
        configPath: input.configPath, entry, paths, sessionId: input.sessionId,
      }, { fresh: true, effect })
    }
    // A closed session's unit is stopped, so nothing its agent started outlives it.
    if ((await readJson<CodingSessionState>(paths.state))?.status === 'closed') await stopOwnUserUnit()
    return
  }
}
