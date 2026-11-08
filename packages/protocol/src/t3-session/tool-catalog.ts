import * as Schema from 'effect/Schema'
import { CommandId, OrchestrationV2Command } from '@nessie/t3-session-source/contracts'
import { ExecutorT3Descriptors, type ExecutorT3Method } from './methods.js'
import { ExecutorT3Routing } from './routing.js'
import { requireClientCommand } from './commands.js'
import { isAdmissibleT3Request } from './validation.js'
import type { ExecutorT3Request } from './request.js'
import ledger from './ledger.json' with { type: 'json' }

export type ExecutorT3ToolOperation = {
  readonly name: string
  readonly method: ExecutorT3Method
  readonly command?: typeof OrchestrationV2Command.Type['type']
  readonly authority: 'read' | 'owner' | 'operate'
  readonly kind: 'finite' | 'stream'
  readonly receipt: 'none' | 'conditional-provider-session' | 'durable-command-or-delivery'
  readonly inputCodec: Schema.Codec<unknown, unknown>
  readonly resultCodec: string
  readonly errorCodec: string
}

// Tool names are presentation identifiers. Original method, command and resource
// identities are retained separately and are never reconstructed from a name.
const nameOf = (kind: 'rpc' | 'command', id: string): string =>
  `t3_session_${kind}_${id.replaceAll('.', '_').replaceAll('-', '_')}`

const inputCodec = (payload: Schema.Codec<unknown, unknown>, receipt: string) => Schema.Struct({
  executorId: ExecutorT3Routing.fields.executorId,
  environmentId: ExecutorT3Routing.fields.environmentId,
  commandId: receipt === 'durable-command-or-delivery' ? CommandId : Schema.optionalKey(CommandId),
  input: payload,
})

/** Schema inventory only. It is not a capability advertisement or a handler registry. */
export const executorT3ToolOperations = (): readonly ExecutorT3ToolOperation[] => {
  const operations: ExecutorT3ToolOperation[] = []
  for (const method of Object.keys(ExecutorT3Descriptors) as ExecutorT3Method[]) {
    // A named command tool binds exactly one discriminant; never offer arbitrary dispatch.
    if (method === 'orchestration.dispatchCommand') continue
    const rule = ledger.rpc[method]
    if (!['read', 'owner', 'operate'].includes(rule.authority)
      || !['finite', 'stream'].includes(rule.kind)
      || !['none', 'conditional-provider-session', 'durable-command-or-delivery'].includes(rule.receipt)) {
      throw new Error('T3_TOOL_POLICY_UNCLASSIFIED')
    }
    operations.push({
      name: nameOf('rpc', method), method,
      authority: rule.authority as ExecutorT3ToolOperation['authority'],
      kind: rule.kind as ExecutorT3ToolOperation['kind'],
      receipt: rule.receipt as ExecutorT3ToolOperation['receipt'],
      inputCodec: inputCodec(ExecutorT3Descriptors[method].payloadSchema, rule.receipt),
      resultCodec: rule.resultCodec, errorCodec: rule.errorCodec,
    })
  }
  const dispatch = ledger.rpc['orchestration.dispatchCommand']
  for (const member of OrchestrationV2Command.members) {
    const command = member.fields.type.literal
    const rule = ledger.commands[command]
    // Answers need canonical Security save/use and a sealed, reference-only tool.
    if (rule.status !== 'pending' || command === 'runtime-request.respond') continue
    operations.push({
      name: nameOf('command', command), method: 'orchestration.dispatchCommand', command,
      authority: 'operate', kind: 'finite', receipt: 'durable-command-or-delivery',
      inputCodec: inputCodec(member, 'durable-command-or-delivery'),
      resultCodec: dispatch.resultCodec, errorCodec: dispatch.errorCodec,
    })
  }
  if (new Set(operations.map(operation => operation.name)).size !== operations.length) {
    throw new Error('T3_TOOL_NAME_COLLISION')
  }
  return operations
}

/** Preserve the original encoded shapes, including opaque IDs and schema definitions. */
export const executorT3ToolInputSchema = (operation: ExecutorT3ToolOperation): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(operation.inputCodec), {
    onExcessProperty: 'error',
  })
  return { ...document.schema, ...(document.definitions ? { $defs: document.definitions } : {}) }
}

type ToolRequest<R> = R extends ExecutorT3Request
  ? Pick<R, 'method' | 'input' | 'commandId' | 'executorId' | 'environmentId'> : never
export type ExecutorT3ToolRequest = ToolRequest<ExecutorT3Request>

/**
 * No epoch, runtime generation, authority, provider override or arbitrary method
 * comes from model arguments. The canonical broker must add and admit its fence.
 * Catch codec failures here: Effect diagnostics can otherwise echo supplied input.
 */
export const decodeExecutorT3ToolInput = (
  operation: ExecutorT3ToolOperation, input: unknown,
): ExecutorT3ToolRequest => {
  try {
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(operation.inputCodec), {
      onExcessProperty: 'error',
    })(input)
    // The catalog pairs this original codec with its original descriptor. This
    // reconnects that correlation after iterating the heterogeneous inventory.
    const request = { ...(decoded as Record<string, unknown>), method: operation.method } as ExecutorT3ToolRequest
    if (!isAdmissibleT3Request(request)) throw new Error('T3_TOOL_INPUT_REJECTED')
    if (request.method === 'orchestration.dispatchCommand') {
      if (request.input.type !== operation.command) throw new Error('T3_TOOL_COMMAND_MISMATCH')
      requireClientCommand(request.input)
    }
    return request
  } catch {
    throw new Error('T3_TOOL_INPUT_REJECTED')
  }
}
