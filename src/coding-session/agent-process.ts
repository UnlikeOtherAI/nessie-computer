import { createWriteStream } from 'node:fs'
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
  send: (text: string, uuid: string) => Promise<void>
  /** Stops the running turn; `reason` becomes the interrupted status's reason. */
  interrupt: (reason?: string) => Promise<void>
  /** Ends the agent and every process under it; the session is closed, `reason` its closed status's reason. */
  close: (reason?: string) => Promise<void>
  /** Ends the agent process only; the session stays resumable. */
  endIdle: () => Promise<void>
  running: () => boolean
  busy: () => boolean
}

export class AgentStartError extends Error {
  override readonly name = 'AgentStartError'
  constructor(readonly reason: string) { super(reason) }
}

export type AgentProcess = {
  confirmHostExecutionStopped?: (snapshot?: readonly CodingProcessIdentity[]) => Promise<boolean>
  identity: CodingProcessIdentity
  write: (text: string) => void
  endInput: () => void
  exited: Promise<{ code: number | null }>
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

export const startAgentProcess = async (
  context: Pick<AgentDriverContext, 'control' | 'env' | 'folder' | 'paths' | 'log' | 'personalAuthority' | 'personalGuard'>,
  argv: readonly string[],
  onLine: (line: string) => void,
): Promise<AgentProcess> => {
  if (context.control.refusal) throw new AgentStartError(context.control.refusal)
  const protectionLease = await admitPersonalHostExecution('coding/terminal', context.personalAuthority, context.personalGuard)
  let child: ChildProcess
  try {
    await rotateLogIfLarge(context.paths.agentStderr, STDERR_LOG_BYTES)
    child = context.control.spawnAgent(argv[0]!, argv.slice(1), { cwd: context.folder, env: context.env })
  }
  catch (error) { await protectionLease?.release(); throw error }
  const spawned = await new Promise<boolean>((settle) => {
    child.once('spawn', () => settle(true))
    child.once('error', () => settle(false))
  })
  if (!spawned || child.pid === undefined) {
    if (child.pid === undefined) await protectionLease?.release()
    throw new AgentStartError('agent_missing')
  }
  let done = false
  // `close` means stdout has been read to the end, so the turn's last line is
  // parsed first. A descendant still holding the pipe would delay it forever,
  // so a second after `exit` is enough.
  const ended = new Promise<{ code: number | null }>((settle) => {
    child.once('exit', (code) => {
      done = true
      setTimeout(() => settle({ code }), 1_000).unref()
    })
    child.once('close', (code) => {
      done = true
      settle({ code })
    })
  })
  const tail: string[] = []
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
  child.stdin?.on('error', () => undefined)
  if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine)
  await protectionLease?.bindExecution({ pid: child.pid })
  // Through the agent guard this is the agent's own identity, which the guard reports; otherwise the child's.
  const identity = await (context.control.identifySpawned?.(child) ?? context.control.identify(child.pid))
  if (!identity) {
    // With no start time, no later kill could tell this process from whatever
    // inherits its pid, so it does not keep running. The handle is still ours.
    const exitedOnItsOwn = done || !codingProcessIsAlive(child.pid)
    if (!done) child.kill('SIGKILL')
    await ended
    // Unknown descendants keep their registration; never call release here.
    throw new AgentStartError(exitedOnItsOwn ? agentFailureReason(tail) : 'containment_failed')
  }
  if (context.control.containment) identity.containment = context.control.containment
  try { await protectionLease?.bindExecution(identity) }
  catch (error) { await context.control.killTree(identity).catch(() => undefined); throw error }
  let released = false
  const confirmHostExecutionStopped = async (snapshot: readonly CodingProcessIdentity[] = []): Promise<boolean> => {
    if (released) return true
    // The legacy killTree's void completion is deliberately never a release proof.
    if (!context.control.stopTree || await context.control.stopTree(identity, snapshot) !== 'stopped') return false
    await protectionLease?.release()
    released = true
    return true
  }
  // Through the agent guard the process this host started is the guard, not the
  // agent. A guard that ends while this host lives — killed, or out of memory —
  // leaves an agent nobody watches (on POSIX it runs on in a group of its own,
  // mid-turn, its pipes broken), and a host that took its guard's end for the
  // agent's would forget the one identity that can still stop it. So the agent's
  // tree is killed, identity-checked, before this host hears that it exited;
  // an agent that has really gone is not there to kill, and no pid alive under
  // its number means no table read at all.
  const exited = ended.then(async (result) => {
    if (context.control.identifySpawned && codingProcessIsAlive(identity.pid)) {
      await context.control.killTree(identity).catch(() => undefined)
    }
    if (protectionLease) await confirmHostExecutionStopped().catch(() => false)
    return result
  })
  return {
    ...(protectionLease ? { confirmHostExecutionStopped } : {}),
    identity,
    write: (text) => {
      if (!done && child.stdin?.writable) child.stdin.write(text)
    },
    endInput: () => {
      if (context.control.endInput) context.control.endInput(child)
      else child.stdin?.end()
    },
    exited,
    alive: () => !done,
    stderrTail: () => [...tail],
  }
}
