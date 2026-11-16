import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { enqueue, handleDaemon, productionAnswer, type DaemonContext, type DaemonOptions } from './daemon.js'
import { claim, handlePairing, referenceFor, revoke, type Reply } from './pairing.js'
import { loadState, saveState, type DebugComputer } from './state.js'

/**
 * The debug control plane: a stand-in for Nessie that a real Nessie Computer
 * pairs with and connects to on this machine, so pairing, the daemon and coding
 * sessions can be driven and read here without a deployed Nessie
 * (`docs/debug-control-plane.md`).
 *
 * It speaks the computer's real protocol under `/api/` and is driven through
 * `/debug/`. It listens on loopback only, and a computer reaches a plain-HTTP
 * address only with `NESSIE_EXECUTOR_ALLOW_LOCAL_API=1`, so nothing here can be
 * reached by, or stand in for, a real Nessie.
 */

export type DebugNessieOptions = Partial<DaemonOptions> & {
  port?: number
  /** Where the control plane remembers its computers; nothing is saved without it. */
  statePath?: string
  log?: (line: string) => void
}

export type DebugNessie = { url: string; port: number; context: DaemonContext; close: () => Promise<void> }

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 8 * 1024 * 1024) throw new Error('The request is too large.')
    chunks.push(Buffer.from(chunk as Buffer))
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

const send = (response: ServerResponse, reply: Reply): void => {
  response.writeHead(reply.status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(reply.error ? { error: reply.error } : { data: reply.data }))
}

/** A computer by its id, the start of its id, or its name; only one may match. */
const findComputer = (context: DaemonContext, wanted: unknown): DebugComputer => {
  const text = typeof wanted === 'string' ? wanted.trim().toLowerCase() : ''
  const live = context.state.computers.filter((computer) => !computer.revoked)
  const matches = text === '' ? live : live.filter((computer) => (
    computer.id.startsWith(text) || computer.label.toLowerCase() === text
    || `${computer.label} ${computer.team?.name ?? ''}`.toLowerCase().includes(text)))
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? 'No connected computer matches that.'
      : `Several computers match; name one of: ${matches.map((computer) => computer.id).join(', ')}`)
  }
  return matches[0]!
}

const summary = (context: DaemonContext) => ({
  options: context.options,
  computers: context.state.computers.map((computer) => ({
    id: computer.id, label: computer.label, organization: computer.organization.name,
    team: computer.team?.name ?? null, revoked: computer.revoked, lastSeenAt: computer.lastSeenAt ?? null,
    connectionEpoch: computer.connectionEpoch, revision: computer.revision,
    sessions: computer.admissions.map((row) => row.sessionId),
  })),
  pairings: context.state.pairings.filter((pairing) => !pairing.code.startsWith('cancelled:')).map((pairing) => ({
    id: pairing.id, code: pairing.code, machineName: pairing.machineName, expiresAt: pairing.expiresAt,
    state: pairing.retainedExecutorId ? 'reused' : pairing.rejected ? 'rejected'
      : pairing.executorId ? 'claimed' : Date.parse(pairing.expiresAt) <= Date.now() ? 'expired' : 'waiting',
    executorId: pairing.executorId ?? null, retainedExecutorId: pairing.retainedExecutorId ?? null,
  })),
  queued: context.queue.map((entry) => ({ commandId: entry.envelope.commandId, executorId: entry.executorId,
    operationKey: entry.envelope.operationKey, accepted: entry.accepted, states: entry.states })),
})

const debugRoute = async (context: DaemonContext, route: string, body: Record<string, unknown>): Promise<Reply> => {
  if (route === 'state') return { status: 200, data: summary(context) }
  if (route === 'claim') {
    const organization = referenceFor('organization', typeof body.organization === 'string' ? body.organization
      : 'Debug Organisation')
    const team = body.team === null ? null : referenceFor('team', typeof body.team === 'string' ? body.team : 'Debug Team')
    const { computer, pairing } = claim(context.state, String(body.code ?? ''), organization, team)
    return { status: 200, data: { executorId: computer.id, pairingId: pairing.id, team: team?.name ?? null } }
  }
  if (route === 'revoke') {
    const computer = findComputer(context, body.computer)
    revoke(context.state, computer)
    return { status: 200, data: { revoked: computer.id } }
  }
  if (route === 'options') {
    if (body.sessions === 'bound' || body.sessions === 'unbound_local') context.options.sessions = body.sessions
    if (typeof body.concurrentPoll === 'boolean') context.options.concurrentPoll = body.concurrentPoll
    if (typeof body.latencyMs === 'number' && body.latencyMs >= 0) context.options.latencyMs = body.latencyMs
    if (typeof body.clockSkewMs === 'number') context.options.clockSkewMs = body.clockSkewMs
    return { status: 200, data: context.options }
  }
  if (route === 'command') {
    const computer = findComputer(context, body.computer)
    const started = Date.now()
    const queued = enqueue(context, computer, String(body.operationKey ?? ''),
      (body.args as Record<string, unknown>) ?? {}, Date.now() + context.options.clockSkewMs)
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : 90_000
    let timer: NodeJS.Timeout | undefined
    const result = await Promise.race([
      queued.result,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) }),
    ])
    clearTimeout(timer)
    if (result === null) {
      const entry = context.queue.find((candidate) => candidate.envelope.commandId === queued.commandId)
      if (entry) context.queue.splice(context.queue.indexOf(entry), 1)
      return { status: 200, data: { commandId: queued.commandId, states: queued.states, timedOut: true,
        note: queued.states.length === 0 ? 'The computer never took the command: is its daemon connected?'
          : 'The computer took the command and has not answered.' } }
    }
    return { status: 200, data: { commandId: queued.commandId, ms: Date.now() - started, states: queued.states,
      authorityChecks: context.authorityChecks.get(queued.commandId) ?? 0,
      production: productionAnswer(context, computer, queued.commandId, result), result } }
  }
  return { status: 404, error: { code: 'NOT_FOUND', message: 'Unknown debug route.' } }
}

export const startDebugNessie = async (options: DebugNessieOptions = {}): Promise<DebugNessie> => {
  const log = options.log ?? (() => undefined)
  const context: DaemonContext = {
    state: await loadState(options.statePath), queue: [], challenges: new Map(), authorities: new Map(),
    authorityChecks: new Map(), log,
    options: { sessions: options.sessions ?? 'bound', concurrentPoll: options.concurrentPoll ?? false,
      latencyMs: options.latencyMs ?? 0, clockSkewMs: options.clockSkewMs ?? 0 },
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? '').split('?')[0]!
    // No doorbell here, as on an older Nessie: the computer polls instead.
    if (path === '/api/executor-daemon/socket') {
      return send(response, { status: 404, error: { code: 'NOT_FOUND', message: 'Not found' } })
    }
    let reply: Reply
    try {
      const body = request.method === 'GET' ? {} : await readBody(request)
      if (path.startsWith('/debug/')) {
        reply = await debugRoute(context, path.slice('/debug/'.length), body)
      } else {
        const wait = context.options.latencyMs
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
        const now = Date.now() + context.options.clockSkewMs
        if (path.startsWith('/api/executor-pairing/')) {
          const action = path.slice('/api/executor-pairing/'.length)
          reply = handlePairing(context.state, action, body, now)
          log(`pairing ${action} -> ${reply.status}${reply.error ? ` ${reply.error.code}` : ''}`)
        } else if (path.startsWith('/api/executor-daemon/')) {
          const route = path.slice('/api/executor-daemon/'.length)
          reply = handleDaemon(context, route, body, now)
          // The steady traffic of a healthy connection is not news; refusals of it are.
          const quiet = ['heartbeat', 'commands/poll', 'session-views', 't3/operations', 't3/catalog'].includes(route)
          if (!quiet || reply.error && reply.status !== 404) {
            log(`daemon ${route} -> ${reply.status}${reply.error ? ` ${reply.error.code}` : ''}`)
          }
        } else {
          // Named, so a route the computer needs and this does not speak yet is seen at once.
          log(`not served: ${request.method ?? 'GET'} ${path}`)
          reply = { status: 404, error: { code: 'NOT_FOUND', message: 'The debug control plane does not serve this route.' } }
        }
      }
      await saveState(options.statePath, context.state)
    } catch (error) {
      reply = { status: 400, error: { code: 'DEBUG_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) } }
    }
    send(response, reply)
  }
  const server: Server = createServer((request, response) => { void handle(request, response) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only: this is never a server for another machine.
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : options.port ?? 0
  return { url: `http://127.0.0.1:${port}`, port, context,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
