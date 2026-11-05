import type { ResponsesContinuation } from '@nessie/executor-protocol'

export type ToolSchemaDescriptor = {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ProviderToolCall = {
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
}

/**
 * An image riding along with a user turn so a vision-capable model can actually
 * look at it. The bytes are inlined rather than referenced by URL: attachment
 * bytes are private to the team and no provider can fetch them.
 *
 * Connectors whose model cannot take images drop these and send the text alone
 * — the turn still names its attachments, so the model knows they exist.
 */
export type ProviderImage = {
  mime: string
  dataBase64: string
}

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ProviderImage[] }
  | {
    role: 'assistant'
    content: string | null
    toolCalls?: ProviderToolCall[]
    /**
     * The reasoning the provider emitted with this turn, kept so a dialect
     * that demands it back (DeepSeek answers 400 on a tool round without it)
     * can replay it. Connectors whose provider has no such field drop it at
     * the transport boundary; see `reasoning-dialect.ts`.
     */
    reasoning?: string
    responsesContinuation?: ResponsesContinuation
    /** A persisted visible Message, not a provider turn from this invocation.
     * DeepSeek thinking-mode tool requests must quote it as historical data
     * when its original reasoning is unavailable. Never sent as a wire field. */
    historicalContext?: 'assistant' | 'application_notice'
  }
  | { role: 'tool'; content: string; toolCallId: string }
