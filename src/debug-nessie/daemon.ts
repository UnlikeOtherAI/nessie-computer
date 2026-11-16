import { randomBytes, randomUUID } from 'node:crypto'

import {
  canonicalExecutorJson, executorCodingSessionOwnerKeyInput, executorCodingSessionResultScope,
  executorSessionCommandArgumentProjection, ExecutorCodingSessionAuthoritySchema, ExecutorCodingSessionOperationSchema,
  ExecutorManagedSessionEvidenceSchema, ExecutorSessionAuthorityCheckSchema,
  type ExecutorCodingSessionAuthority, type ExecutorCodingSessionOperation, type ExecutorCommandEnvelope,
} from '@nessie/executor-protocol'

import type { Reply } from './pairing.js'
import { digest, sha256, signedBy, type DebugComputer, type DebugState, type QueuedCommand } from './state.js'

/**
 * Nessie's side of a connected computer: the challenge and claim, the policy
 * revision, heartbeats, the command poll and its receipts, and the
 * session-authority round trip a coding session makes before it acts.
 *
 * Coding sessions are the reason this exists. In production the model sees
 * only `EXECUTOR_CODING_SESSION_CALL_REFUSED`; here the computer's own answer
 * is returned whole, beside the word production would have used.
 */

export type DaemonOptions = {
  /** `bound` mirrors a hosted Nessie with UOA; `unbound_local` a self-hosted install with no identity provider. */
  sessions: 'bound' | 'unbound_local'
  /** Hosted Nessie refuses the concurrent poll today, so the computer runs one command at a time. */
  concurrentPoll: boolean
  /** Added to every answer, to stand in for a real network and database. */
  latencyMs: number
  /** How far this control plane's clock runs ahead of the computer's (negative: behind). */
  clockSkewMs: number
}

export type DaemonContext = {
  state: DebugState
  queue: QueuedCommand[]
  challenges: Map<string, string>
  authorities: Map<string, ExecutorCodingSessionAuthority>
  /** How many times each command asked the session-authority route, the cost a slow server multiplies. */
  authorityChecks: Map<string, number>
  options: DaemonOptions
  log: (line: string) => void
}

/** The one debug agent and person every command is stamped with. */
export const DEBUG_OWNER = {
  agentId: '00000000-0000-4000-8000-00000000d0a1',
  actorUserId: '00000000-0000-4000-8000-00000000d0a2',
}
const RUN_ID = '00000000-0000-4000-8000-00000000d0b0'
const BINDING_ID = '00000000-0000-4000-8000-00000000d0b1'

const ok = (data: unknown): Reply => ({ status: 200, data })
const refuse = (status: number, code: string, message: string): Reply => ({ status, error: { code, message } })

const READ_OPERATIONS: readonly ExecutorCodingSessionOperation[] = ['session_list', 'session_status', 'terminal_read']

/** The bridge tool a session call names, as the operation Nessie would authorise. */
const operationOf = (tool: string): ExecutorCodingSessionOperation | undefined => (
  ExecutorCodingSessionOperationSchema.safeParse(tool).data
)

export const ownerKeyOf = (executorId: string): `sha256:${string}` => (
  digest(executorCodingSessionOwnerKeyInput(executorId, DEBUG_OWNER))
)

const authorityFor = (
  computer: DebugComputer, commandId: string, operation: ExecutorCodingSessionOperation, sessionId: string | undefined,
  now: number,
): ExecutorCodingSessionAuthority => {
  const admissions = operation === 'session_start' ? []
    : operation === 'session_list' ? computer.admissions.slice(0, 32)
      : computer.admissions.filter((row) => row.sessionId === sessionId)
  return ExecutorCodingSessionAuthoritySchema.parse({
    version: 1, executorId: computer.id, originalOwnerGeneration: computer.originalOwnerGeneration,
    ownerKey: ownerKeyOf(computer.id), commandId, operation,
    purpose: READ_OPERATIONS.includes(operation) ? 'read' : 'control',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
    connectionEpoch: String(computer.connectionEpoch), authorizationRevision: computer.authorizationRevision,
    filter: {}, admissions,
  })
}

/** Queues one command for a computer and resolves with the result it acknowledges. */
export const enqueue = (
  context: DaemonContext, computer: DebugComputer, operationKey: string, args: Record<string, unknown>,
  now = Date.now(),
): { commandId: string; result: Promise<Record<string, unknown>>; states: string[] } => {
  const commandId = randomUUID()
  const bridgeTool = operationKey === 'mcp.call' && args.server === 'coding-sessions' && typeof args.tool === 'string'
    ? args.tool : undefined
  const operation = bridgeTool && context.options.sessions === 'bound' ? operationOf(bridgeTool) : undefined
  const toolArguments = args.arguments as { sessionId?: string } | undefined
  const authority = operation ? authorityFor(computer, commandId, operation, toolArguments?.sessionId, now) : undefined
  if (authority) context.authorities.set(commandId, authority)
  const payload = {
    args, runId: RUN_ID,
    ...(operationKey.startsWith('mcp.') ? { owner: DEBUG_OWNER } : {}),
    ...(authority ? { codingSessionAuthority: authority } : {}),
  }
  computer.fence += 1
  const envelope = {
    commandId, bindingId: BINDING_ID, bindingFence: String(computer.fence), capabilityRevision: computer.revision,
    operationKey, expiresAt: new Date(now + 60_000).toISOString(), idempotencyKey: `debug-${commandId}`,
    argumentDigest: digest(canonicalExecutorJson(executorSessionCommandArgumentProjection(payload))), payload,
  } as unknown as ExecutorCommandEnvelope
  const states: string[] = []
  const result = new Promise<Record<string, unknown>>((settle) => {
    context.queue.push({ envelope, executorId: computer.id, accepted: false, createdAt: now, states, settle })
  })
  return { commandId, result, states }
}

/**
 * What hosted Nessie would hand the agent for this result. It checks the same
 * things in the same order as the server's result authority, and remembers an
 * accepted start so later calls may name that session.
 */
export const productionAnswer = (
  context: DaemonContext, computer: DebugComputer, commandId: string, result: Record<string, unknown>,
): string => {
  const authority = context.authorities.get(commandId)
  if (!authority) return 'passed through unchanged'
  const content = Array.isArray(result.content) && result.content.length === 1
    ? result.content[0] as { text?: unknown } : null
  let body: Record<string, unknown> | undefined
  try {
    body = typeof content?.text === 'string' ? JSON.parse(content.text) as Record<string, unknown> : undefined
  } catch { /* withheld below */ }
  if (!body || canonicalExecutorJson(body.resultScope)
    !== canonicalExecutorJson(executorCodingSessionResultScope(authority))) {
    return 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD (no result scope matching the command)'
  }
  if (result.success !== true || result.isError === true) return 'EXECUTOR_CODING_SESSION_CALL_REFUSED'
  if (authority.operation === 'session_start') {
    const proof = ExecutorManagedSessionEvidenceSchema.safeParse(body.startEvidence)
    if (!proof.success || proof.data.startCommandId !== commandId || proof.data.sessionId !== body.sessionId
      || body.startPhase !== 'request_and_host_created') {
      return 'EXECUTOR_CODING_SESSION_RESULT_WITHHELD (start evidence missing or not request_and_host_created)'
    }
    if (!computer.admissions.some((row) => row.sessionId === proof.data.sessionId)) computer.admissions.push(proof.data)
  }
  return 'delivered to the agent'
}

export const handleDaemon = (
  context: DaemonContext, route: string, body: Record<string, unknown>, now = Date.now(),
): Reply => {
  const { state } = context
  if (route === 'teams') {
    const entries = Array.isArray(body.entries) ? body.entries as Array<{ executorId?: string }> : []
    return ok({ teams: entries.flatMap((entry) => {
      const computer = state.computers.find((candidate) => candidate.id === entry.executorId && !candidate.revoked)
      return computer ? [{ executorId: computer.id, organizationName: computer.organization.name,
        teamName: computer.team?.name ?? null }] : []
    }) })
  }
  const computer = state.computers.find((entry) => entry.id === body.executorId)
  if (!computer) return refuse(404, 'EXECUTOR_NOT_FOUND', 'Executor not found.')
  if (route === 'challenge') {
    if (computer.revoked) return refuse(409, 'EXECUTOR_STATE_TRANSITION_INVALID', 'Executor access was revoked.')
    const challenge = `${randomBytes(48).toString('base64url')}.${randomBytes(32).toString('base64url')}`
    context.challenges.set(computer.id, challenge)
    return ok({ challenge, expiresAt: new Date(now + 60_000).toISOString() })
  }
  if (route === 'claim') {
    const challenge = context.challenges.get(computer.id)
    if (computer.revoked || !challenge || body.challenge !== challenge || !signedBy(computer.machinePublicKey,
      'nessie.executor.daemon.claim.v1', { challenge, executorId: computer.id }, body.signature)) {
      return refuse(401, 'EXECUTOR_DAEMON_PROOF_INVALID', 'Machine proof is invalid.')
    }
    context.challenges.delete(computer.id)
    computer.connectionEpoch += 1
    computer.lastSeenAt = new Date(now).toISOString()
    const source = { executorId: computer.id, acceptedPairing: { kind: 'code', id: computer.pairingId },
      machinePublicKeyDigest: sha256(computer.machinePublicKey) }
    return ok({ connectionEpoch: String(computer.connectionEpoch), status: 'online',
      sessionPairingSource: context.options.sessions === 'bound'
        ? { ...source, kind: 'bound', originalOwnerGeneration: computer.originalOwnerGeneration }
        : { ...source, kind: 'unbound_local' } })
  }
  if (computer.revoked || body.connectionEpoch !== String(computer.connectionEpoch)) {
    return refuse(409, 'EXECUTOR_CONNECTION_FENCED', 'Executor connection is fenced.')
  }
  computer.lastSeenAt = new Date(now).toISOString()
  if (route === 'descriptor') {
    const signed = body.descriptor as { descriptor?: { revision?: number } } | undefined
    const revision = signed?.descriptor?.revision
    if (typeof revision !== 'number') return refuse(400, 'VALIDATION_ERROR', 'A descriptor carries its revision.')
    if (revision < computer.revision) {
      return refuse(409, 'EXECUTOR_DESCRIPTOR_ROLLBACK', 'Executor descriptor revisions cannot move backwards.')
    }
    computer.revision = revision
    computer.descriptor = signed?.descriptor
    return ok({ reviewStatus: 'active', revision })
  }
  if (route === 'heartbeat') {
    return ok({ connectionEpoch: String(computer.connectionEpoch), status: 'online', existingSessionsAllowed: true })
  }
  if (route === 'session-views') return ok({ requests: [] })
  if (route === 'commands/poll') {
    const waiting = context.queue.filter((entry) => entry.executorId === computer.id && !entry.accepted)
    if (body.concurrency !== undefined) {
      if (!context.options.concurrentPoll) {
        return refuse(400, 'VALIDATION_ERROR', "Unrecognized key(s) in object: 'concurrency'")
      }
      return ok({ commands: waiting.map((entry) => entry.envelope), cancellations: [], sessionClose: [] })
    }
    if (body.activeCommand) return ok({ command: null, cancellation: null })
    return ok({ command: waiting[0]?.envelope ?? null })
  }
  if (route === 'commands/receipt') {
    const receipt = body.receipt as { commandId?: string; state?: string } | undefined
    const entry = context.queue.find((candidate) => candidate.envelope.commandId === receipt?.commandId)
    if (entry && receipt?.state) {
      entry.states.push(receipt.state)
      if (receipt.state === 'accepted') entry.accepted = true
      if (receipt.state === 'result_acknowledged') {
        context.queue.splice(context.queue.indexOf(entry), 1)
        entry.settle((body.result as Record<string, unknown> | undefined) ?? {})
      }
    }
    return ok({ recorded: true })
  }
  if (route === 'session-authority') {
    const parsed = ExecutorSessionAuthorityCheckSchema.safeParse(body)
    if (!parsed.success) return refuse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.')
    const { signature, ...payload } = parsed.data
    const authority = context.authorities.get(payload.commandId)
    const selectionDigest = authority
      && digest(canonicalExecutorJson(executorCodingSessionResultScope(authority)))
    if (!authority || payload.selectionDigest !== selectionDigest || !signedBy(computer.machinePublicKey,
      'nessie.executor.daemon.session_authority.v1', payload, signature)) {
      context.log(`session authority refused for command ${payload.commandId} (${payload.phase})`)
      return refuse(400, 'EXECUTOR_SESSION_AUTHORITY_UNAVAILABLE', 'Original session authority is unavailable.')
    }
    context.authorityChecks.set(payload.commandId, (context.authorityChecks.get(payload.commandId) ?? 0) + 1)
    context.log(`session authority ${payload.phase} for ${authority.operation} (command ${payload.commandId})`)
    return ok({ commandId: payload.commandId, selectionDigest, phase: payload.phase, purpose: authority.purpose,
      requestNonce: payload.requestNonce, requestDigest: digest(canonicalExecutorJson(payload)),
      connectionEpoch: String(computer.connectionEpoch), authorizationRevision: computer.authorizationRevision,
      validUntil: new Date(now + 5_000).toISOString(),
      authority: { ...authority, issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString() } })
  }
  return refuse(404, 'NOT_FOUND', 'Not found')
}
