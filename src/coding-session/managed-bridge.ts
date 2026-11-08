import { SessionEffectAuthority } from './session-effect-authority.js'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ExecutorCodingSessionCloseSchema, type PersonalInferenceAuthority,
  type ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'
import { listManagedSessions } from './managed-session-list.js'
import { claimManagedStart, recordManagedStartOutcome, reconcileManagedStart } from './managed-session-start.js'
import { managedSessionEvidence, preparedManagedSessionAuthority, originalManagedEffectScope,
  readSessionPairingSource, requireManagedSessionEvidence } from './session-authority.js'
import { assertPersonalHostExecution } from '../personal-host-execution.js'

import {
  argumentsFor,
  CodingBridgeError,
  invalidArguments,
  pullRequestArgument,
  requiredText,
  sessionIdArgument,
} from './bridge-tools.js'
import type { LocalCommandPolicy } from '../command-policy.js'
import { buildAgentEnvironment } from './agent-env.js'
import { codingSessionsDigestMatches, offeredCodingAgents, type LoadedCodingSessionsConfig } from './config.js'
import { ensureCodingSessionHost, resolveExecutorEntry } from './host-spawn.js'
import type { PathRewriter } from './path-rewrite.js'
import { reviewCodingSession } from './review.js'
import {
  CodingRootError,
  findCodingRoot,
  normalizeCodingPath,
  resolveCodingFolder,
  resolveCodingRoots,
  type CodingRootSet,
} from './roots.js'
import { parseEventCursor } from './session-events.js'
import {
  codingCommandsDir,
  codingSessionPaths,
  codingSessionsDir,
  createJsonExclusive,
  ensureCodingStateDir,
  ensurePrivateDir,
  readJson,
  readJsonPatiently,
  type CodingSessionPaths,
} from './session-files.js'
import {
  claimCommand,
  COMMAND_ID_PATTERN,
  listSessionMetas,
  pruneCommandRecords,
  readSessionMeta,
  writeRequest,
  type CommandRecord,
} from './session-requests.js'
import { answerSessionRequest } from './session-answer.js'
import { composeCodingStatus, deriveCodingStatus } from './status.js'
import { costOf, reportCodingSessions } from './session-report.js'
import { readSessionScreen, sessionScreenText } from './session-view.js'
import { terminalLaunch } from './terminal-launch.js'
import {
  codingSessionIsLive,
  type CodingAgentName,
  type CodingSessionMeta,
  type CodingSessionState,
} from './types.js'

/**
 * The stateless half of coding sessions: every call reads what it needs from
 * the state directory, writes a request if it has to, makes sure a host is
 * alive, and answers in well under five seconds (a review has its own 20 s).
 *
 * Owners are structural. The daemon names the owner of every call in the
 * reserved `_meta['nessie/owner']`, which the model cannot reach; a call
 * without one is refused, `session_list` shows only the caller's sessions,
 * and every other tool answers "No such session" for somebody else's.
 *
 * A configuration that no longer matches its reviewed digest changes nothing
 * until a person reviews it: its roots are never resolved, and every tool but
 * the ones that only stop or report things (close, interrupt, and the
 * daemon's close-all and list-all) answers `coding_session_config_changed`.
 */
export type CodingBridgeCallMeta = {
  connectionEpoch?: string
  sessionPairingSource?: import('@nessie/executor-protocol').ExecutorSessionPairingSource
  codingSessionAuthority?: import('@nessie/executor-protocol').ExecutorCodingSessionAuthority
  personalAuthority?: PersonalInferenceAuthority
  ownerKey?: string
  commandId?: string
  daemonControl: boolean
  /** This computer's command rules, from the daemon: what a terminal session may start. */
  commandRules?: LocalCommandPolicy
}

export type CodingBridge = {
  call: (tool: string, args: unknown, meta: CodingBridgeCallMeta) => Promise<Record<string, unknown>>
  /** What every answer passes through once more on its way out (`bridge-server.ts`). */
  rewriter: PathRewriter
}

const OWNER_KEY_PATTERN = /^[A-Za-z0-9:_-]{8,128}$/u

/**
 * The control plane's own grammar for a close reason (`lease_ended`, `access_revoked`, `daemon_shutdown`, …),
 * the one its close instructions are checked against, so the two cannot drift apart.
 */
const CloseReasonSchema = ExecutorCodingSessionCloseSchema.shape.reason

/** What a changed, unreviewed configuration still allows: stopping things, and the daemon's report. */
const ALLOWED_UNREVIEWED = new Set([
  'session_close', 'session_interrupt', 'session_close_all', 'session_list_all', 'session_inventory',
])

const titleFrom = (prompt: string): string => {
  const first = prompt.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? 'Coding session'
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

/** How a terminal session's program exited, once it has: whether the command it ran succeeded. */
const exitOf = (state: CodingSessionState | undefined): { exitCode?: number } => (
  state?.exitCode === undefined ? {} : { exitCode: state.exitCode }
)

/** Where a new session runs and what it is first given. */
type StartTarget = { rootName: string; path: string; title: string; prompt: string; command?: string[]; cwd?: string }

export const createCodingBridge = async (loaded: LoadedCodingSessionsConfig): Promise<CodingBridge> => {
  const reviewed = codingSessionsDigestMatches(loaded)
  const rootSet: CodingRootSet = await resolveCodingRoots(
    reviewed ? loaded : { ...loaded, config: { ...loaded.config, roots: [] } },
  )
  // review runs git and gh as the person does: the MCP SDK's minimal PATH
  // finds no Homebrew gh on macOS, while the host's self-check, which uses the
  // rebuilt login environment, finds it. Built once, when first needed.
  let reviewEnvironment: Promise<NodeJS.ProcessEnv> | undefined
  const reviewEnv = (): Promise<NodeJS.ProcessEnv> => {
    reviewEnvironment ??= buildAgentEnvironment({ config: loaded.config.agentEnv }).catch(() => process.env)
    return reviewEnvironment
  }
  await ensureCodingStateDir(loaded.stateDir)
  await ensurePrivateDir(codingSessionsDir(loaded.stateDir))
  await ensurePrivateDir(codingCommandsDir(loaded.stateDir))
  void pruneCommandRecords(loaded.stateDir).catch(() => undefined)
  const entry = resolveExecutorEntry()
  const { stateDir } = loaded

  const owner = (meta: CodingBridgeCallMeta): string => {
    if (!meta.ownerKey || !OWNER_KEY_PATTERN.test(meta.ownerKey)) {
      throw new CodingBridgeError(
        'coding_session_owner_missing',
        'This call names no owner. Coding sessions are reached only through Nessie, which names the owner of every call.',
      )
    }
    return meta.ownerKey
  }

  const commandIdOf = (meta: CodingBridgeCallMeta): string => (
    meta.commandId && COMMAND_ID_PATTERN.test(meta.commandId) ? meta.commandId : randomUUID()
  )

  const owned = async (
    sessionId: unknown, ownerKey: string, authority?: ExecutorCodingSessionAuthority,
  ): Promise<{ paths: CodingSessionPaths; meta: CodingSessionMeta }> => {
    const paths = codingSessionPaths(stateDir, sessionIdArgument(sessionId))
    const meta = await readSessionMeta(paths)
    if (!meta || meta.ownerKey !== ownerKey) throw new CodingBridgeError('coding_session_not_found', 'No such session.')
    if (authority) requireManagedSessionEvidence(authority, meta)
    return { paths, meta }
  }

  // Patient: a scanner holding session.json for a moment must not read as a session nobody started.
  const readState = (paths: CodingSessionPaths) => readJsonPatiently<CodingSessionState>(paths.state)

  const requireReviewedConfig = (): void => {
    if (!codingSessionsDigestMatches(loaded)) {
      throw new CodingBridgeError(
        'coding_session_config_changed',
        'The coding-sessions configuration on this machine changed since it was reviewed. '
        + 'A person has to review the executor policy again before sessions can start or continue.',
      )
    }
  }

  /** `fresh` for a new request, which gets hosts of its own even after earlier ones failed to start. */
  const ensureHost = (paths: CodingSessionPaths, sessionId: string, fresh = false, effect?: SessionEffectAuthority) => ensureCodingSessionHost({
    configPath: loaded.configPath, entry, paths, sessionId,
  }, { fresh, effect })

  /** A command id seen before returns the first outcome and does nothing else. */
  const replayed = async (commandId: string, ownerKey: string): Promise<CommandRecord | undefined> => {
    const existing = await readJson<CommandRecord>(join(codingCommandsDir(stateDir), `${commandId}.json`))
    if (existing && existing.ownerKey !== ownerKey) throw new CodingBridgeError('coding_session_not_found', 'No such session.')
    return existing
  }

  const briefStatus = async (paths: CodingSessionPaths) => {
    const state = await readState(paths)
    const derived = await deriveCodingStatus(paths, state)
    return {
      status: derived.status, ...(derived.reason ? { reason: derived.reason } : {}), ...costOf(state), ...exitOf(state),
    }
  }

  /** Claude Code and Codex: a task, in a folder inside one of the reviewed roots. */
  const structuredTarget = async (value: unknown): Promise<StartTarget> => {
    const args = argumentsFor(value, ['agent', 'root', 'path', 'prompt', 'title'])
    const root = findCodingRoot(rootSet, args.root)
    const path = normalizeCodingPath(args.path)
    await resolveCodingFolder(root, path)
    const prompt = requiredText(args.prompt, 'prompt', 32_000)
    const title = args.title === undefined ? titleFrom(prompt) : requiredText(args.title, 'title', 120).trim()
    return { rootName: root.name, path, title, prompt }
  }

  /** A terminal: the program the agent names, when this computer's command rules permit it, in any folder. */
  const terminalTarget = async (value: unknown, commandRules: LocalCommandPolicy | undefined): Promise<StartTarget> => {
    const launch = await terminalLaunch(value, commandRules)
    return { rootName: 'terminal', path: '.', title: launch.title, prompt: '', command: launch.command, cwd: launch.cwd }
  }

  const start = async (
    value: unknown, ownerKey: string, commandId: string, commandRules: LocalCommandPolicy | undefined,
    personalAuthority?: PersonalInferenceAuthority,
    authority?: ExecutorCodingSessionAuthority, effect?: SessionEffectAuthority,
  ): Promise<Record<string, unknown>> => {
    // A command already acted on answers with its first outcome, before anything is checked again: rules
    // tightened or a folder removed since then must not turn the retry of a start that happened into a refusal.
    if (authority) {
      await effect!.consume()
      const accepted = await reconcileManagedStart(stateDir, authority)
      if (accepted) { await effect!.consume(); return accepted.replay }
    }
    const previous = authority ? undefined : await replayed(commandId, ownerKey)
    if (previous) {
      const paths = codingSessionPaths(stateDir, previous.sessionId)
      return { sessionId: previous.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const agent = (value && typeof value === 'object' ? (value as Record<string, unknown>).agent : undefined) as CodingAgentName
    const offered = offeredCodingAgents(loaded.config)
    if (typeof agent !== 'string' || !offered.includes(agent)) invalidArguments(`agent must be one of: ${offered.join(', ')}.`)
    const target = agent === 'terminal' ? await terminalTarget(value, commandRules) : await structuredTarget(value)
    requireReviewedConfig()
    const live = []
    for (const meta of await listSessionMetas(stateDir)) {
      if (meta.ownerKey !== ownerKey) continue
      const paths = codingSessionPaths(stateDir, meta.sessionId)
      if (codingSessionIsLive((await deriveCodingStatus(paths, await readState(paths))).status)) live.push(meta)
    }
    if (live.length >= loaded.config.maxLiveSessionsPerOwner) {
      throw new CodingBridgeError(
        'coding_session_quota_exceeded',
        `You already have ${live.length} open coding sessions on this machine, the most it allows. Close one first.`,
      )
    }
    const original = authority ? await claimManagedStart(stateDir, authority, effect) : undefined
    if (original?.replay) { await effect?.consume(); return original.replay }
    const sessionId = original?.sessionId ?? randomUUID()
    const claimed = authority ? undefined : await claimCommand(stateDir,
      { commandId, ownerKey, tool: 'session_start', sessionId, at: new Date().toISOString() })
    if (claimed) {
      const paths = codingSessionPaths(stateDir, claimed.sessionId)
      return { sessionId: claimed.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const paths = codingSessionPaths(stateDir, sessionId)
    effect?.assertLive()
    await mkdir(paths.inbox, { recursive: true, mode: 0o700 })
    const { rootName, path, title } = target
    const meta: CodingSessionMeta = {
      version: 1, sessionId, ownerKey, agent, rootName, path, title, createdAt: new Date().toISOString(),
      ...(authority ? { originalManagedStart: { executorId: authority.executorId,
        originalOwnerGeneration: authority.originalOwnerGeneration, startCommandId: commandId } } : {}),
      ...(personalAuthority ? { personalAuthority } : {}),
      ...(target.command ? { command: target.command, cwd: target.cwd! } : {}),
    }
    const created = await createJsonExclusive(paths.meta, meta, effect)
    if (authority && !created) throw new CodingBridgeError('coding_session_start_outcome_unknown',
      'The original start metadata conflicts. Reconcile the original command before starting again.')
    effect?.assertLive()
    const written = await writeRequest(paths, { id: commandId, kind: 'start', text: target.prompt, at: meta.createdAt }, effect)
    if (authority && !written) throw new CodingBridgeError('coding_session_start_outcome_unknown',
      'The original start request conflicts. Reconcile the original command before starting again.')
    const host = await ensureHost(paths, sessionId, true, effect)
    if (authority && host !== 'spawned' && host !== 'live') throw new CodingBridgeError('coding_session_start_outcome_unknown',
      'The original host creation is unconfirmed. Reconcile the original command before starting again.')
    const result = { sessionId, status: 'starting', agent, ...(target.command ? {} : { root: rootName, path }), title,
      ...(authority ? { startPhase: 'request_and_host_created' } : {}),
      ...(meta.originalManagedStart ? { startEvidence: managedSessionEvidence(meta.originalManagedStart, sessionId, ownerKey) } : {}) }
    if (authority) await recordManagedStartOutcome(stateDir, authority, result)
    return result
  }

  /** send, interrupt and close: one request per executor command, then a live host. */
  const request = async (
    kind: 'send' | 'interrupt' | 'close', value: unknown, ownerKey: string, commandId: string,
    authority?: ExecutorCodingSessionAuthority, effect?: SessionEffectAuthority,
  ): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, kind === 'send' ? ['sessionId', 'message', 'terminal'] : ['sessionId'])
    const { paths, meta } = await owned(args.sessionId, ownerKey, authority)
    if (args.terminal === true && meta.agent !== 'terminal') invalidArguments('This is not a terminal session.')
    const raw = kind === 'send' && meta.agent === 'terminal'
    if (raw && (typeof args.message !== 'string' || !args.message.length || args.message.length > 32_000)) {
      invalidArguments('Terminal input must contain 1 to 32000 characters.')
    }
    const text = kind === 'send' ? raw ? args.message as string : requiredText(args.message, 'message', 32_000) : undefined
    if (kind === 'send') requireReviewedConfig()
    if (await replayed(commandId, ownerKey)) {
      return { sessionId: meta.sessionId, ...await briefStatus(paths), replayed: true }
    }
    const state = await readState(paths)
    const derived = await deriveCodingStatus(paths, state)
    if (derived.status === 'closed') {
      if (kind === 'close') return { sessionId: meta.sessionId, status: 'closed' }
      throw new CodingBridgeError('coding_session_closed', 'That session is closed. Start a new one.')
    }
    if (kind === 'send' && derived.status === 'failed') {
      throw new CodingBridgeError(
        'coding_session_failed',
        `That session failed (${derived.reason ?? 'unknown'}) and cannot continue. Start a new one once the cause is fixed.`,
      )
    }
    // Nothing is running to interrupt: no live host, and no agent a lost host may have left behind.
    if (kind === 'interrupt' && !derived.hostLive && !derived.hostStarting && derived.reason !== 'host_lost') {
      return { sessionId: meta.sessionId, status: derived.status, interrupted: false }
    }
    await claimCommand(stateDir, { commandId, ownerKey, tool: `session_${kind}`, sessionId: meta.sessionId, at: new Date().toISOString() }, effect)
    const at = new Date().toISOString()
    await writeRequest(paths, { id: commandId, kind, ...(text === undefined ? {} : { text }), at }, effect)
    await ensureHost(paths, meta.sessionId, true, effect)
    return {
      sessionId: meta.sessionId,
      status: kind === 'close' ? 'closing' : derived.status,
      // The turn the message was sent at: to a session that is not working it
      // starts the next one, so a caller knows which answer is still owed.
      ...(kind === 'send' ? { queued: true, turn: state?.turn ?? 0, ...costOf(state) } : {}),
      ...(kind === 'interrupt' ? { interrupted: true } : {}),
    }
  }

  const status = async (value: unknown, ownerKey: string, authority?: ExecutorCodingSessionAuthority): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, ['sessionId', 'detail', 'cursor'])
    const { paths, meta } = await owned(args.sessionId, ownerKey, authority)
    if (args.detail !== undefined && args.detail !== 'summary' && args.detail !== 'events') {
      invalidArguments('detail must be summary or events.')
    }
    const cursor = args.cursor === undefined ? undefined : parseEventCursor(args.cursor)
    if (args.cursor !== undefined && !cursor) invalidArguments('cursor must be a nextCursor this tool returned.')
    const state = await readState(paths)
    const derived = await deriveCodingStatus(paths, state)
    // Requests waiting with no host to read them (a host that died, or one that
    // exited in the instant a request landed) get a host, so the next read sees
    // them delivered. A host started under a changed config only stops things.
    if (!authority && derived.inboxPending > 0 && !derived.hostLive && !derived.hostStarting) {
      await ensureHost(paths, meta.sessionId)
    }
    return composeCodingStatus({
      paths, meta, state, derived, detail: (args.detail ?? 'summary') as 'summary' | 'events', ...(cursor ? { cursor } : {}),
    })
  }

  const review = async (value: unknown, ownerKey: string, authority?: ExecutorCodingSessionAuthority): Promise<Record<string, unknown>> => {
    const args = argumentsFor(value, ['sessionId', 'pullRequest'])
    const { paths, meta } = await owned(args.sessionId, ownerKey, authority)
    if (meta.agent === 'terminal') {
      throw new CodingBridgeError('coding_session_review_unavailable', 'A terminal session has no review: read its screen.')
    }
    const pullRequest = args.pullRequest === undefined ? undefined : pullRequestArgument(args.pullRequest)
    const root = findCodingRoot(rootSet, meta.rootName)
    const folder = await resolveCodingFolder(root, meta.path)
    const state = await readState(paths)
    return {
      sessionId: meta.sessionId,
      ...await briefStatus(paths),
      ...await reviewCodingSession({
        folder, rootCanonical: root.canonical!, rewriter: rootSet.rewriter, state, env: await reviewEnv(),
        ...(pullRequest === undefined ? {} : { pullRequest }),
      }),
    }
  }

  const daemonOnly = (meta: CodingBridgeCallMeta): void => {
    if (!meta.daemonControl) {
      throw new CodingBridgeError('coding_session_daemon_only', 'Only the executor daemon may close or report every session.')
    }
  }

  /**
   * The daemon's teardown: close every session, one owner's, or one of theirs,
   * wherever the daemon already stops work and whenever the control plane says so.
   * Its reason is the closed session's, so a close forced by a revocation reads
   * differently on the machine from one the owner asked for.
   */
  const closeAll = async (
    value: unknown, meta: CodingBridgeCallMeta, commandId: string,
  ): Promise<Record<string, unknown>> => {
    daemonOnly(meta)
    const args = argumentsFor(value, ['ownerKey', 'sessionId', 'reason'])
    if (args.ownerKey !== undefined && (typeof args.ownerKey !== 'string' || !OWNER_KEY_PATTERN.test(args.ownerKey))) {
      invalidArguments('ownerKey must be an owner key.')
    }
    if (args.sessionId !== undefined && args.ownerKey === undefined) invalidArguments('sessionId needs its ownerKey.')
    const only = args.sessionId === undefined ? undefined : sessionIdArgument(args.sessionId)
    // It becomes the closed session's own reason, which everything that reads one takes for a category.
    const reason = requiredText(args.reason, 'reason', 64)
    if (!CloseReasonSchema.safeParse(reason).success) invalidArguments('reason must be a categorical reason such as lease_ended.')
    // Side by side: every host start may take a moment, and many sessions must not add up past the call's budget.
    const closed = await Promise.all((await listSessionMetas(stateDir)).map(async (session) => {
      if (args.ownerKey !== undefined && session.ownerKey !== args.ownerKey) return 0
      if (only !== undefined && session.sessionId !== only) return 0
      const paths = codingSessionPaths(stateDir, session.sessionId)
      const derived = await deriveCodingStatus(paths, await readState(paths))
      if (derived.status === 'closed') return 0
      await writeRequest(paths, { id: `close-all-${commandId}`.slice(0, 128), kind: 'close', reason, at: new Date().toISOString() })
      await ensureHost(paths, session.sessionId, true)
      return 1
    }))
    return { closing: closed.reduce((sum: number, count) => sum + count, 0) }
  }

  /** The daemon's heartbeat report and inventory (`session-report.ts`). */
  const listAll = async (
    value: unknown, meta: CodingBridgeCallMeta, includeClosed = false,
  ): Promise<Record<string, unknown>> => {
    daemonOnly(meta)
    argumentsFor(value, [])
    return { sessions: await reportCodingSessions(stateDir, rootSet.rewriter, includeClosed) }
  }

  return {
    rewriter: rootSet.rewriter,
    call: async (tool, args, meta) => {
      try {
        const authority = preparedManagedSessionAuthority(meta)
        const effectScope = originalManagedEffectScope(meta)
        const effect = effectScope ? new SessionEffectAuthority(dirname(loaded.configPath), effectScope) : undefined
        const system = meta.daemonControl && ['session_close_all', 'session_list_all', 'session_inventory'].includes(tool)
        if (!system) await readSessionPairingSource(dirname(loaded.configPath), meta.sessionPairingSource)
        if (meta.sessionPairingSource?.kind === 'bound' && !authority
          && !['session_close_all', 'session_list_all', 'session_inventory'].includes(tool)) {
          throw new CodingBridgeError('coding_session_authority_unavailable', 'Original session authority is unavailable.')
        }
        if (['session_start', 'session_send', 'session_review'].includes(tool)) {
          await assertPersonalHostExecution(meta.personalAuthority)
        }
        const commandId = commandIdOf(meta)
        if (!reviewed && tool !== 'session_start' && !ALLOWED_UNREVIEWED.has(tool)) requireReviewedConfig()
        if (tool === 'session_close_all') return await closeAll(args, meta, commandId)
        if (tool === 'session_list_all') return await listAll(args, meta)
        if (tool === 'session_inventory') return await listAll(args, meta, true)
        const ownerKey = owner(meta)
        if (tool === 'terminal_read') {
          const view = argumentsFor(args, ['sessionId'])
          const session = await owned(view.sessionId, ownerKey, authority)
          const screen = await readSessionScreen(session.paths, session.meta)
          return {
            sessionId: session.meta.sessionId, ...await briefStatus(session.paths),
            text: await sessionScreenText(screen),
          }
        }
        if (tool === 'session_list') {
          argumentsFor(args, authority ? ['provider', 'cursor', 'search'] : [])
          return await listManagedSessions(loaded, rootSet, ownerKey, authority)
        }
        if (tool === 'session_start') {
          return await start(args, ownerKey, commandId, meta.commandRules, meta.personalAuthority, authority, effect)
        }
        if (tool === 'session_status') return await status(args, ownerKey, authority)
        if (tool === 'session_send') return await request('send', args, ownerKey, commandId, authority, effect)
        if (tool === 'session_interrupt') return await request('interrupt', args, ownerKey, commandId, authority, effect)
        if (tool === 'session_close') return await request('close', args, ownerKey, commandId, authority, effect)
        if (tool === 'session_review') return await review(args, ownerKey, authority)
        if (tool === 'session_answer') {
          daemonOnly(meta)
          const { sessionId, answer } = argumentsFor(args, ['sessionId', 'answer'])
          const { paths, meta: session } = await owned(sessionId, ownerKey, authority)
          return await answerSessionRequest({ paths, answer, commandId, effect,
            hostLive: (await deriveCodingStatus(paths, await readState(paths))).hostLive,
            folder: () => resolveCodingFolder(findCodingRoot(rootSet, session.rootName), session.path),
            ensureHost: () => ensureHost(paths, session.sessionId, false, effect) })
        }
        throw new CodingBridgeError('coding_session_unknown_tool', 'That is not a coding-sessions tool.')
      } catch (error) {
        if (error instanceof CodingRootError) throw new CodingBridgeError(`coding_session_${error.code}`, error.message)
        throw error
      }
    },
  }
}
