import { join } from 'node:path'

import { CliRefusal, type HostRun } from './cli-output.js'
import { packagedRuntimeDirectory } from './runtime-integrity.js'

/**
 * The teams the Windows background service runs, reached the way the Windows
 * app reaches them: one request line on the service's control pipe
 * (`\\.\pipe\NessieExecutor`), one answer line back. The service decides who
 * may ask — its pipe admits Administrators and the accounts it recorded when
 * they connected a team — and answers each command under its own account
 * rules, such as program requests only for the account that connected the team.
 *
 * The pipe is opened by the installed service executable's `--control` mode,
 * not here: only native code can check that the pipe is served by the signed
 * service, running as its own account, before a request is sent to it.
 */

export const SERVICE_RELAY = 'nessie-executor-service.exe'

export type ServiceRequest = { command: string } & Record<string, unknown>
export type ServiceAnswer = { status: string } & Record<string, unknown>
/** One request and its answer; the real relay outside tests. */
export type ServiceCall = (request: ServiceRequest) => Promise<ServiceAnswer>

/** Why the service could not be asked at all, as the relay reports it. */
export type ServiceUnreachableReason = 'notInstalled' | 'notRunning' | 'notAdmitted' | 'notTrusted' | 'busy' | 'failed'

const UNREACHABLE: Record<ServiceUnreachableReason, string> = {
  notInstalled: 'The Nessie Computer service isn\'t installed on this computer.',
  notRunning: 'The Nessie Computer service isn\'t running. Start it in Windows Services, or restart the computer.',
  notAdmitted: 'This Windows account can\'t use the Nessie Computer service yet. It can once you add a ChatGPT plan '
    + 'or connect a team through the service.',
  notTrusted: 'Something other than the Nessie Computer service answered on its control channel, so nothing was sent.',
  busy: 'The Nessie Computer service is busy. Try again in a moment.',
  failed: 'The Nessie Computer service couldn\'t be reached. Try again, or restart the computer.',
}

export class ServiceUnreachable extends CliRefusal {
  constructor(readonly reason: ServiceUnreachableReason) {
    super('SERVICE_UNREACHABLE', UNREACHABLE[reason])
    this.name = 'ServiceUnreachable'
  }
}

const REASONS = new Set<string>(Object.keys(UNREACHABLE))
const UNREADABLE = 'Nessie Computer couldn\'t understand its service\'s reply. Try again, or restart the computer.'
const ANSWER_LIMIT = 1_048_576

/** The relay's one line, read strictly: an answer this reader does not recognise is a failure. */
export const decodeServiceAnswer = (text: string): ServiceAnswer => {
  if (!text.endsWith('\n') || text.length > ANSWER_LIMIT) throw new ServiceUnreachable('failed')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new CliRefusal('SERVICE_ANSWER_UNREADABLE', UNREADABLE) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || typeof (parsed as { status?: unknown }).status !== 'string') {
    throw new CliRefusal('SERVICE_ANSWER_UNREADABLE', UNREADABLE)
  }
  const answer = parsed as ServiceAnswer
  if (answer.status === 'unreachable') {
    const reason = String(answer.reason)
    throw new ServiceUnreachable(REASONS.has(reason) ? reason as ServiceUnreachableReason : 'failed')
  }
  return answer
}

/**
 * The real relay: the installed service executable beside this runtime, run
 * as this account. Only the installed command line has one; a development
 * run reaches no service.
 */
export const windowsServiceRelay = (run: HostRun, platform: NodeJS.Platform = process.platform): ServiceCall => (
  async (request) => {
    if (platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') {
      throw new ServiceUnreachable('notInstalled')
    }
    const result = await run(join(packagedRuntimeDirectory(), SERVICE_RELAY), ['--control'],
      { input: `${JSON.stringify(request)}\n` })
    if (result.code === null) throw new ServiceUnreachable('notInstalled')
    if (result.code !== 0) throw new ServiceUnreachable('failed')
    return decodeServiceAnswer(result.stdout)
  }
)

/** The answer of the expected kind; the service's refusal in its own words otherwise. */
export const expectAnswer = (answer: ServiceAnswer, status: string): ServiceAnswer => {
  if (answer.status === 'error') {
    throw new CliRefusal('SERVICE_REFUSED', typeof answer.reason === 'string' && answer.reason
      ? answer.reason : 'The Nessie Computer service refused the request.')
  }
  if (answer.status !== status) throw new CliRefusal('SERVICE_ANSWER_UNREADABLE', UNREADABLE)
  return answer
}

/** One team as the service reports it: its daemon, pause, failure and waiting requests. Never a path. */
export type ServiceTeamStatus = {
  executorId: string
  daemonStatus: string
  paused: boolean
  pendingProgramRequests: number
  failure?: { code?: string; message: string }
}

const statusRow = (value: unknown): ServiceTeamStatus => {
  const row = value as Partial<ServiceTeamStatus> | null
  if (!row || typeof row.executorId !== 'string' || typeof row.daemonStatus !== 'string'
    || typeof row.paused !== 'boolean' || typeof row.pendingProgramRequests !== 'number') {
    throw new CliRefusal('SERVICE_ANSWER_UNREADABLE', UNREADABLE)
  }
  const failure = row.failure && typeof row.failure.message === 'string' ? { failure: row.failure } : {}
  return { executorId: row.executorId, daemonStatus: row.daemonStatus, paused: row.paused,
    pendingProgramRequests: row.pendingProgramRequests, ...failure }
}

/** The service's list after a status check or a change: `{ status: 'ok', executors }`. */
export const serviceTeamList = (answer: ServiceAnswer): ServiceTeamStatus[] => {
  const executors = expectAnswer(answer, 'ok').executors
  if (!Array.isArray(executors)) throw new CliRefusal('SERVICE_ANSWER_UNREADABLE', UNREADABLE)
  return executors.map(statusRow)
}

/** Every service command the command line sends, by name: the same requests the Windows app sends. */
export const serviceRequests = {
  status: (): ServiceRequest => ({ command: 'status' }),
  describe: (executorId: string): ServiceRequest => ({ command: 'describe', executorId }),
  configure: (executorId: string, configurationInput: unknown): ServiceRequest => (
    { command: 'configureInput', executorId, configurationInput }),
  setPaused: (executorId: string, paused: boolean): ServiceRequest => ({ command: 'setPaused', executorId, paused }),
  programRequests: (executorId: string): ServiceRequest => ({ command: 'programRequests', executorId }),
  answer: (executorId: string, id: string, answer: string): ServiceRequest => (
    { command: 'answerProgramRequest', executorId, id, answer }),
  audience: (executorId: string): ServiceRequest => ({ command: 'audience', executorId }),
  inference: (executorId: string, operation: unknown): ServiceRequest => (
    { command: 'inferenceConnections', executorId, operation }),
  remove: (executorId: string): ServiceRequest => ({ command: 'remove', executorId }),
  /** A connected team's names, or with no id the pairing the service has open. */
  pairingStatus: (executorId?: string): ServiceRequest => ({ command: 'pairingStatus', executorId: executorId ?? null }),
  pairingStart: (apiBaseUrl: string, workspaceRoot: string): ServiceRequest => (
    { command: 'pairingStart', apiBaseUrl, workspaceRoot, replace: false }),
  pairingCancel: (): ServiceRequest => ({ command: 'pairingCancel' }),
} as const
