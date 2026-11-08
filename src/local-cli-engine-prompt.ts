import type { LocalInferenceAttemptRequest, ProviderToolCall } from '@nessie/executor-protocol'

import { LocalCliEngineError } from './local-cli-engine-error.js'

/**
 * How a Nessie model turn travels to a CLI and back (docs/local-cli-engines.md).
 * The CLI never runs a tool: Nessie's tool descriptions are part of the
 * prompt, and the CLI proposes calls in one fenced block after its reply. The
 * block is a structural marker this host defines, not a reading of meaning.
 */
export const CLI_TOOL_BLOCK_OPEN = '<nessie_tool_calls>'
export const CLI_TOOL_BLOCK_CLOSE = '</nessie_tool_calls>'

export const CLI_ENGINE_SYSTEM_PROMPT = 'You are the model behind an agent in Nessie. Answer the next assistant '
  + 'turn of the conversation you are given. Your own tools, files, shell and network are disabled; never try '
  + 'to use them.'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Text only: an image part, or any content that is not text, is refused rather than dropped. */
const plain = (content: unknown): string | null => {
  if (content === null || typeof content === 'string') return content
  if (!Array.isArray(content)) throw new LocalCliEngineError('unsupported_capability')
  return content.map((part) => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') {
      throw new LocalCliEngineError('unsupported_capability')
    }
    return part.text
  }).join('')
}

export const cliEnginePrompt = (attempt: LocalInferenceAttemptRequest): string => {
  const messages = attempt.messages.map((message) => message.role === 'tool'
    ? { role: 'tool', toolCallId: message.toolCallId, content: message.content }
    : message.role === 'assistant'
      ? { role: 'assistant', content: plain(message.content),
        ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map(
          ({ toolCallId, toolName, arguments: args }) => ({ toolCallId, toolName, arguments: args })) } : {}) }
      : { role: message.role, content: plain(message.content) })
  const tools = attempt.tools.map(({ toolName, description, inputSchema }) => ({ toolName, description, inputSchema }))
  return [
    'Write the reply the assistant gives next, as plain text, in the language of the conversation.',
    tools.length
      ? [`You may also propose tool calls. Nessie runs them and sends the results in a later turn. To propose any, end`,
        `your reply with this block and nothing after it:\n${CLI_TOOL_BLOCK_OPEN}\n`
        + '[{"toolName":"<a supplied tool name>","arguments":{…}}]\n'
        + `${CLI_TOOL_BLOCK_CLOSE}\nUse only the supplied tool names; arguments must match the tool's input schema.`,
      ].join(' ')
      : 'No tools are available for this turn.',
    'The conversation and the available tools, as JSON:',
    JSON.stringify({ messages, tools }),
  ].join('\n\n')
}

/**
 * Splits streamed reply text from the tool block. `push` answers the text that
 * is safe to show now, holding back a tail that could be the start of the
 * block's opening marker; `finish` answers the rest of the reply and the block.
 */
export const createCliReplySplitter = () => {
  let buffer = ''
  let shown = 0
  let opened = -1
  const hold = CLI_TOOL_BLOCK_OPEN.length - 1
  return {
    push: (text: string): string => {
      buffer += text
      if (opened >= 0) return ''
      opened = buffer.indexOf(CLI_TOOL_BLOCK_OPEN)
      let held = Math.min(hold, buffer.length - shown)
      while (held > 0 && !buffer.endsWith(CLI_TOOL_BLOCK_OPEN.slice(0, held))) held -= 1
      const safe = opened >= 0 ? opened : buffer.length - held
      const chunk = buffer.slice(shown, safe)
      shown = safe
      return chunk
    },
    /** The reply text held back while it could still have become the block's marker. */
    tail: (): string => {
      if (opened >= 0) return ''
      const chunk = buffer.slice(shown)
      shown = buffer.length
      return chunk
    },
    finish: (): { reply: string; block: string | null } => {
      const at = buffer.indexOf(CLI_TOOL_BLOCK_OPEN)
      return at < 0 ? { reply: buffer, block: null }
        : { reply: buffer.slice(0, at), block: buffer.slice(at + CLI_TOOL_BLOCK_OPEN.length) }
    },
  }
}

/** Only supplied tool names with object arguments; anything else means the turn is incomplete. */
export const parseCliToolBlock = (
  block: string, attempt: Pick<LocalInferenceAttemptRequest, 'attemptId' | 'tools'>,
): ProviderToolCall[] => {
  const close = block.indexOf(CLI_TOOL_BLOCK_CLOSE)
  if (close < 0 || block.slice(close + CLI_TOOL_BLOCK_CLOSE.length).trim()) {
    throw new LocalCliEngineError('inference_incomplete')
  }
  let calls: unknown
  try { calls = JSON.parse(block.slice(0, close)) as unknown } catch { throw new LocalCliEngineError('inference_incomplete') }
  if (!Array.isArray(calls) || calls.length > 128) throw new LocalCliEngineError('inference_incomplete')
  return calls.map((call, index) => {
    if (!record(call) || Object.keys(call).some((key) => !['toolName', 'arguments'].includes(key))
      || typeof call.toolName !== 'string' || !attempt.tools.some((tool) => tool.toolName === call.toolName)
      || !record(call.arguments)) throw new LocalCliEngineError('inference_incomplete')
    return { toolCallId: `${attempt.attemptId}:cli-${index + 1}`, toolName: call.toolName, arguments: call.arguments }
  })
}
