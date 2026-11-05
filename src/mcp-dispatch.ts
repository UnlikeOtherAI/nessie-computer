import {
  ExecutorMcpCallArgumentsSchema,
  ExecutorMcpCallPayloadSchema,
  ExecutorMcpToolsArgumentsSchema,
  ExecutorMcpToolsPayloadSchema,
} from '@nessie/executor-protocol'

import type { CodingSessionsDaemon } from './coding-sessions-daemon.js'
import type { ExecutorMcpImageSink } from './mcp-images.js'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'

// A refusal is part of a terminal result, which the control plane caps; the
// model needs the first few faults, not every one a hostile payload can make.
const MAX_NAMED_ISSUES = 5
const MAX_FIELD_LENGTH = 64

// The shape of a schema issue this refusal reads; the envelope schemas' own
// issues are exactly this, without the package having to name their library.
type ArgumentIssue = {
  code: string
  keys?: readonly string[]
  message: string
  path: readonly (string | number)[]
}

const fieldName = (path: readonly (string | number)[]): string =>
  path.length === 0 ? 'the arguments' : `\`${path.join('.').slice(0, MAX_FIELD_LENGTH)}\``

/**
 * The envelope refusal, naming what to change, so the model can correct its
 * call instead of guessing. It is built from field names and the schema's own
 * messages only, never from a field's value, and each name is bounded.
 */
const invalidArguments = (
  operationKey: 'mcp.tools' | 'mcp.call',
  issues: readonly ArgumentIssue[],
): Record<string, unknown> => {
  const fields: string[] = []
  const faults: string[] = []
  for (const issue of issues.slice(0, MAX_NAMED_ISSUES)) {
    if (issue.code === 'unrecognized_keys' && issue.keys) {
      const keys = issue.keys.slice(0, MAX_NAMED_ISSUES).map((key) => key.slice(0, MAX_FIELD_LENGTH))
      fields.push(...keys)
      faults.push(`unexpected ${keys.map((key) => `\`${key}\``).join(', ')}`)
      continue
    }
    fields.push(issue.path.join('.').slice(0, MAX_FIELD_LENGTH))
    faults.push(`${fieldName(issue.path)}: ${issue.message}`)
  }
  return {
    code: 'EXECUTOR_COMMAND_ARGUMENTS_INVALID',
    fields,
    message: `The ${operationKey} arguments were refused — ${faults.join('; ')}.`,
    success: false,
  }
}

/**
 * The daemon's two MCP proxy operations.
 *
 * Both refuse outright when this daemon has no session manager, which is how a
 * build that cannot front a local server says so rather than failing at the
 * first call. The policy check itself is the session manager's, and it happens
 * before any process starts.
 *
 * `images` is where an `mcp.call`'s images are kept — the daemon writes them
 * as the command's sidecars (`command-attachments.ts`).
 */
export const executeExecutorMcpCommand = async (
  operationKey: 'mcp.tools' | 'mcp.call',
  args: unknown,
  sessions: ExecutorMcpSessionManager | undefined,
  bridge?: {
    codingBridge?: Pick<CodingSessionsDaemon, 'callMeta'>
    commandId: string
    /**
     * The whole delivered payload, checked strictly: its server-stamped
     * `owner` is the only thing beside `args` and `runId` it may carry.
     */
    payload: unknown
  },
  images?: ExecutorMcpImageSink,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  if (!sessions) return { code: 'EXECUTOR_MCP_UNAVAILABLE', success: false }
  if (operationKey === 'mcp.tools') {
    const parsed = ExecutorMcpToolsArgumentsSchema.safeParse(args)
    if (!parsed.success) return invalidArguments(operationKey, parsed.error.issues)
    const payload = bridge ? ExecutorMcpToolsPayloadSchema.safeParse(bridge.payload) : undefined
    if (payload && !payload.success) return invalidArguments(operationKey, payload.error.issues)
    const authority = payload?.data.personalAuthority
    if (authority && (authority.runId !== payload?.data.runId
      || payload?.data.owner && (authority.agent.id !== payload.data.owner.agentId
        || authority.principal.ownerUserId !== payload.data.owner.actorUserId))) {
      return { code: 'EXECUTOR_PERSONAL_AUTHORITY_INVALID', success: false }
    }
    return sessions.listTools(parsed.data.server, parsed.data.cursor, signal, authority)
  }
  const parsed = ExecutorMcpCallArgumentsSchema.safeParse(args)
  if (!parsed.success) return invalidArguments(operationKey, parsed.error.issues)
  const payload = bridge ? ExecutorMcpCallPayloadSchema.safeParse(bridge.payload) : undefined
  if (payload && !payload.success) return invalidArguments(operationKey, payload.error.issues)
  const owner = payload?.data.owner
  const personalAuthority = payload?.data.personalAuthority
  if (personalAuthority && (personalAuthority.runId !== payload?.data.runId
    || owner && (personalAuthority.agent.id !== owner.agentId
      || personalAuthority.principal.ownerUserId !== owner.actorUserId))) {
    return { code: 'EXECUTOR_PERSONAL_AUTHORITY_INVALID', success: false }
  }
  // `arguments` is passed through untouched: the tool's own grammar belongs to
  // the server, and validating it here would guarantee drift the first time
  // that server ships a new field. Who the call is for travels beside it, in
  // reserved `_meta`, and only to the executor's own coding-sessions bridge.
  const meta = bridge?.codingBridge?.callMeta(parsed.data.server, {
    commandId: bridge.commandId,
    ...(owner ? { owner } : {}),
  })
  const callMeta = personalAuthority ? { ...meta, 'nessie/personal-authority': personalAuthority } : meta
  return sessions.callTool(parsed.data.server, parsed.data.tool, parsed.data.arguments, callMeta, images, signal)
}
