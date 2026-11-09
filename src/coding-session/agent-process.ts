import { effectTransport } from './effect-transport.js'
import { createAgentProcessInput } from './agent-process-input.js'
import type { SessionEffectAuthority } from './session-effect-authority.js'
import { createWriteStream } from 'node:fs'
import { basename } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { CodingAgentConfig } from './config.js'
import { codingProcessIsAlive, type CodingProcessControl } from './process-control.js'
import type { Projector } from './projection.js'
import { rotateLogIfLarge, type CodingSessionPaths } from './session-files.js'
import type { CodingEventBody, CodingProcessIdentity, CodingSessionState } from './types.js'
import { admitPersonalHostExecution } from '../personal-host-execution.js'
import type { PersonalInferenceAuthority } from '@nessie/executor-protocol'
import type { PersonalInferenceGuard } from '../personal-inference-guard.js'
import type { SessionRequestBook } from './session-request-book.js'
import type { SessionSecretServer } from './session-secret-server.js'
import { createAgentByteTransport, type AgentByteProcess } from './agent-byte-transport.js'
import { createCodingProcessControl, packagedJobHelper } from './process-control.js'
import { assertWindowsMachineHostAllowed } from '../windows-machine-host.js'
import { isT3EffectScope } from './session-effect-scope.js'

/**
 * What both agent drivers share: the context a host gives them, and one
 * spawned coding-agent process with its stdout read as lines and its stderr
 * kept on disk (bounded) and in memory (its last lines), where a failure's
 * categorical reason comes from.
 */

export type AgentDriverContext = {
  agent: CodingAgentConfig
  control: CodingProcessControl
  env: NodeJS.ProcessEnv
  folder: string
  /** The reviewed named folders, as declared and as resolved: no approval reaches past them. */
  roots: readonly string[]
  maxBudgetUsd?: number
  paths: CodingSessionPaths
  projector: Projector
  /** Re-reads the host lock immediately before an agent starts; `false` means another host owns the session. */
  stillOwner: () => Promise<boolean>
  emit: (body: CodingEventBody) => void
  update: (patch: Partial<CodingSessionState>) => void
  state: () => CodingSessionState
  log: (message: string) => void
  personalAuthority?: PersonalInferenceAuthority
  personalGuard?: PersonalInferenceGuard
  /** What the agent waits on its owner for; the driver opens requests here and answers its provider. */
  requests: SessionRequestBook
  /** The `request_secret` MCP server the agent is given. */
  secretServer?: SessionSecretServer
}

export type AgentDriver = {
  /** The first message starts (or resumes) the agent; later ones follow up. */
  send: (text: string, uuid: string, effect?: SessionEffectAuthority) => Promise<void>
  /** Stops the running turn; `reason` becomes the interrupted status's reason. */
  interrupt: (reason?: string, effect?: SessionEffectAuthority) => Promise<void>
  /** Ends the agent and every process under it; the session is closed, `reason` its closed status's reason. */
  close: (reason?: string, effect?: SessionEffectAuthority) => Promise<void>
  /** Ends the agent process only; the session stays resumable. */
  endIdle: () => Promise<void>
  running: () => boolean
  busy: () => boolean
}

export class AgentStartError extends Error {
  override readonly name = 'AgentStartError'
  constructor(readonly reason: string) { super(reason) }
}

/** The caller must retain this identity as stop debt; process exit alone cannot clear it. */
export class AgentProcessStopUnproved extends AgentStartError {
  constructor(readonly identity?: CodingProcessIdentity, readonly spawnedPid?: number) { super('provider_stop_unproved') }
}

export type AgentProcessExit = { code: number | null; clearance: 'stopped' | 'unknown' }

export type AgentProcess = {
  confirmHostExecutionStopped: (
    snapshot?: readonly CodingProcessIdentity[], effect?: SessionEffectAuthority,
  ) => Promise<boolean>
  identity: CodingProcessIdentity
  write: (text: string, effect?: SessionEffectAuthority) => Promise<void>
  writeProtocol: (text: string) => Promise<void>
  endInput: (effect?: SessionEffectAuthority) => Promise<void>
  exited: Promise<AgentProcessExit>
  alive: () => boolean
  stderrTail: () => string[]
}

const STDERR_LOG_BYTES = 1024 * 1024
const STDERR_TAIL_LINES = 40

/**
 * A categorical reason from the agent's last stderr lines. The line itself
 * never leaves the host: it can carry an account name or a host path.
 */
const NOT_LOGGED_IN = new RegExp(
  'not logged in|please (run|use) .{0,40}login|invalid api key|authentication (failed|required)|unauthori[sz]ed',
  'iu',
)

export const agentFailureReason = (lines: readonly string[]): string => {
  const text = lines.join('\n')
  // The Windows job helper's and the agent guard's own refusals: either ran nothing, or stopped what it started.
  if (/"code":"EXECUTOR_(JOB|GUARD)_SPAWN_FAILED"/u.test(text)) return 'agent_missing'
  if (/"code":"EXECUTOR_(JOB_(CONTAINMENT_FAILED|PARENT_GONE)|GUARD_(CONTAINMENT_FAILED|NO_AGENT|HOST_GONE))"/u.test(text)) return 'containment_failed'
  if (NOT_LOGGED_IN.test(text)) return 'agent_not_logged_in'
  if (/usage limit|quota|rate limit/iu.test(text)) return 'agent_quota_exhausted'
  return 'agent_exited'
}

export type AgentProcessContext = Pick<AgentDriverContext,
  'control' | 'env' | 'folder' | 'paths' | 'log' | 'personalAuthority' | 'personalGuard'>

export const startAgentProcess = async (
  context: AgentProcessContext,
  argv: readonly string[],
  onLine: (line: string) => void,
  effect?: SessionEffectAuthority,
): Promise<AgentProcess> => {
  if (effect && isT3EffectScope(effect.scope)) throw new AgentStartError('t3_provider_requires_byte_transport')
  const { child: _child, rawExit: _rawExit, closed: _closed, ...agent } =
    await startOwnedAgentProcess(context, argv, onLine, effect)
  return agent
}

/** Original SDK byte hooks use only the protected creator, never a raw spawn port. */
export const startAgentByteProcess = async (
  context: Omit<AgentProcessContext, 'control'>, argv: readonly string[], effect: SessionEffectAuthority,
): Promise<AgentByteProcess> => {
  const scope = effect.scope
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1'
    || basename(process.execPath).toLowerCase() !== 'nessie-executor-runtime.exe'
    || !isT3EffectScope(scope)) throw new AgentStartError('protected_provider_transport_unavailable')
  const helper = packagedJobHelper()
  if (!helper) throw new AgentStartError('protected_provider_transport_unavailable')
  await assertWindowsMachineHostAllowed()
  const control = createCodingProcessControl('win32', { jobHelper: helper, packaged: true })
  const owned = await startOwnedAgentProcess({ ...context, control }, argv, undefined, effect)
  try {
    if (!effectTransport(owned.child)) throw new AgentStartError('protected_provider_transport_unavailable')
    return createAgentByteTransport(owned, scope)
  } catch (error) {
    if (!await owned.confirmHostExecutionStopped().catch(() => false)) {
      throw new AgentProcessStopUnproved(owned.identity)
    }
    throw error
  }
}

const startOwnedAgentProcess = async (
  context: AgentProcessContext, argv: readonly string[], onLine: ((line: string) => void) | undefined,
  effect?: SessionEffectAuthority,
): Promise<AgentProcess & {
  child: ChildProcess; rawExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  closed: Promise<void> }> => {
  if (context.control.refusal) throw new AgentStartError(context.control.refusal)
  if (!context.control.stopTree) throw new AgentProcessStopUnproved()
  const protectionLease = await admitPersonalHostExecution('coding/terminal', context.personalAuthority, context.personalGuard)
  let child: ChildProcess
  try {
    await rotateLogIfLarge(context.paths.agentStderr, STDERR_LOG_BYTES)
    await effect?.consume()
    effect?.assertLive()
    child = context.control.spawnAgent(argv[0]!, argv.slice(1), { cwd: context.folder, env: context.env,
      ...(effect ? { sessionEffect: effect } : {}) })
  }
  catch (error) { await protectionLease?.release(); throw error }
  const spawned = await new Promise<boolean>((settle) => {
    child.once('spawn', () => settle(true))
    child.once('error', () => settle(false))
  })
  if (!spawned || child.pid === undefined) {
    if (child.pid === undefined) await protectionLease?.release()
    if (child.pid !== undefined) throw new AgentProcessStopUnproved(undefined, child.pid)
    throw new AgentStartError('agent_missing')
  }
  let done = false
  const rawExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  // `close` means stdout has been read to the end, so the turn's last line is
  // parsed first. A descendant still holding the pipe would delay it forever,
  // so a second after `exit` is enough.
  const ended = new Promise<{ code: number | null }>((settle) => {
    child.once('exit', (code) => {
      done = true
      if (onLine) setTimeout(() => settle({ code }), 1_000).unref()
      else settle({ code }) // Byte streams drain independently, without a truncating timer.
    })
    child.once('close', (code) => {
      done = true
      settle({ code })
    })
  })
  const tail: string[] = []
  if (onLine) {
    const log = createWriteStream(context.paths.agentStderr, { flags: 'a', mode: 0o600 })
    let logged = 0
    log.on('error', () => undefined)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (logged < STDERR_LOG_BYTES) {
        logged += chunk.byteLength
        log.write(chunk)
      }
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
        if (!line.trim()) continue
        tail.push(line.slice(0, 500))
        if (tail.length > STDERR_TAIL_LINES) tail.shift()
      }
    })
    void ended.then(() => log.end())
  }
  child.stdin?.on('error', () => undefined)
  if (child.stdout && onLine) createInterface({ input: child.stdout }).on('line', onLine)
  let bindingError: unknown
  try { await protectionLease?.bindExecution({ pid: child.pid }) } catch (error) { bindingError = error }
  // Through the agent guard this is the agent's own identity, which the guard reports; otherwise the child's.
  let identity: CodingProcessIdentity | undefined
  try { identity = await (context.control.identifySpawned?.(child) ?? context.control.identify(child.pid)) }
  catch { /* An identification failure cannot discharge this child's stop debt. */ }
  if (!identity) {
    // With no start time, no later kill could tell this process from whatever
    // inherits its pid, so it does not keep running. The handle is still ours.
    await context.control.killChildTree(child).catch(() => false)
    if (!done) child.kill('SIGKILL')
    // Unknown descendants keep their registration; never call release here.
    throw new AgentProcessStopUnproved(undefined, child.pid)
  }
  if (context.control.containment) identity.containment = context.control.containment
  let released = false
  let clearing: Promise<boolean> | undefined
  const confirmHostExecutionStopped = async (
    snapshot: readonly CodingProcessIdentity[] = [], authority?: SessionEffectAuthority,
  ): Promise<boolean> => {
    if (released) return true
    await authority?.consume()
    authority?.assertLive()
    clearing ??= (async () => {
      // Every child requires positive proof, even without a personal credential lease.
      if (await context.control.stopTree!(identity, snapshot, authority) !== 'stopped') return false
      await protectionLease?.release()
      released = true
      return true
    })().finally(() => { clearing = undefined })
    return clearing
  }
  try {
    if (bindingError) throw bindingError
    await protectionLease?.bindExecution(identity)
    await effectTransport(child)?.ready
  }
  catch (error) {
    if (!await confirmHostExecutionStopped().catch(() => false)) throw new AgentProcessStopUnproved(identity)
    throw error
  }
  // Through the agent guard the process this host started is the guard, not the
  // agent. A guard that ends while this host lives — killed, or out of memory —
  // leaves an agent nobody watches (on POSIX it runs on in a group of its own,
  // mid-turn, its pipes broken), and a host that took its guard's end for the
  // agent's would forget the one identity that can still stop it. So the agent's
  // tree is killed, identity-checked, before this host hears that it exited;
  // an agent that has really gone is not there to kill, and no pid alive under
  // its number means no table read at all.
  const exited: Promise<AgentProcessExit> = ended.then(async (result) => {
    if (context.control.identifySpawned && codingProcessIsAlive(identity.pid)) {
      await context.control.killTree(identity).catch(() => undefined)
    }
    const stopped = await confirmHostExecutionStopped().catch(() => false)
    return { ...result, clearance: stopped ? 'stopped' : 'unknown' }
  })
  const input = createAgentProcessInput(child)
  return {
    child, rawExit, closed,
    confirmHostExecutionStopped,
    identity,
    ...input,
    endInput: (authority) => input.endInput(() => {
      if (context.control.endInput) context.control.endInput(child)
      else child.stdin?.end()
    }, authority),
    exited,
    alive: () => !done,
    stderrTail: () => [...tail],
  }
}
