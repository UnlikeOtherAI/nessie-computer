import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { ENV_NAME_PATTERN, normalizedSecretDestination, SecretDestinationError } from './secret-destination.js'
import { writeJsonAtomic } from './session-files.js'

/**
 * `nessie-executor serve-session-secrets --session-dir <dir>`: the MCP server
 * a managed session's coding agent starts, with one tool, `request_secret`.
 *
 * A call leaves an ask in the session's `secret-asks/`, which the session's
 * host turns into a `secret` request for the owner, and waits for the host's
 * outcome in `secret-answers/`. The owner's value is written straight into
 * the named file by the executor; this process never sees it, and the tool
 * result says only where it was saved.
 */

export const SESSION_SECRET_SERVER_NAME = 'nessie_session'
export const SESSION_SECRET_TOOL_NAME = 'request_secret'
/** As Claude Code names the tool, for its permission prompt. */
export const SESSION_SECRET_CLAUDE_TOOL = `mcp__${SESSION_SECRET_SERVER_NAME}__${SESSION_SECRET_TOOL_NAME}`

export type SecretAsk = {
  askId: string; name: string; reason: string; destination: string; envName?: string; at: string
}
export type SecretOutcome =
  | { outcome: 'saved'; destination: string }
  | { outcome: 'declined' | 'cancelled' | 'expired' | 'refused'; reason: string }

const WAIT_MS = 250

const tool = {
  name: SESSION_SECRET_TOOL_NAME,
  description: 'Ask the person who owns this session for a secret (an API key, a token, a password) and have it '
    + 'written into a file in your working folder, owner-only. You never see the value; the result says where it '
    + 'was saved, so read it from that file where your code needs it. Use envName to set one NAME=value line in a '
    + '.env file instead of writing the whole file. Never ask for a secret in chat.',
  inputSchema: {
    type: 'object' as const, additionalProperties: false, required: ['name', 'reason', 'destination'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'What is needed, e.g. "Stripe test secret key".' },
      reason: { type: 'string', minLength: 1, maxLength: 4_000, description: 'Why you need it, for the person.' },
      destination: {
        type: 'string', minLength: 1, maxLength: 1_000,
        description: 'A file name in your working folder itself, e.g. ".env.local"; not a path into a subfolder.',
      },
      envName: { type: 'string', pattern: ENV_NAME_PATTERN.source, description: 'The variable name in a .env file.' },
    },
  },
}

/** The ask a call makes, or a refusal naming what is wrong with its arguments. */
export const secretAskOf = (value: unknown): SecretAsk | { refused: string } => {
  const args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const text = (field: unknown, max: number): string | undefined => (
    typeof field === 'string' && field.trim() && field.length <= max ? field.trim() : undefined
  )
  const name = text(args.name, 200)
  const reason = text(args.reason, 4_000)
  if (!name || !reason) return { refused: 'name and reason are required text.' }
  if (args.envName !== undefined && (typeof args.envName !== 'string' || !ENV_NAME_PATTERN.test(args.envName))) {
    return { refused: 'envName must be a variable name such as STRIPE_SECRET_KEY.' }
  }
  try {
    return {
      askId: randomUUID(), name, reason, destination: normalizedSecretDestination(args.destination),
      ...(typeof args.envName === 'string' ? { envName: args.envName } : {}), at: new Date().toISOString(),
    }
  } catch (error) {
    return { refused: error instanceof SecretDestinationError ? error.message : 'destination is not a usable path.' }
  }
}

export const secretOutcomeText = (ask: Pick<SecretAsk, 'name'>, outcome: SecretOutcome): string => (
  outcome.outcome === 'saved'
    ? `The owner provided ${ask.name}. It was saved to ${outcome.destination} (owner-only). `
      + 'The value was not shown to you; read it from that file where your code needs it.'
    : `The owner did not provide ${ask.name} (${outcome.outcome}: ${outcome.reason}). Do not ask for it in chat; `
      + 'continue without it or say what you could not do.'
)

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

export const serveSessionSecrets = async (sessionDir: string): Promise<void> => {
  const asks = join(sessionDir, 'secret-asks')
  const answers = join(sessionDir, 'secret-answers')
  await mkdir(asks, { recursive: true, mode: 0o700 })
  await mkdir(answers, { recursive: true, mode: 0o700 })
  let closed = false
  const server = new Server({ name: 'nessie-session', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== SESSION_SECRET_TOOL_NAME) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown tool.' }] }
    }
    const ask = secretAskOf(request.params.arguments)
    if ('refused' in ask) return { isError: true, content: [{ type: 'text', text: ask.refused }] }
    await writeJsonAtomic(join(asks, `${ask.askId}.json`), ask)
    const answerPath = join(answers, `${ask.askId}.json`)
    for (;;) {
      if (closed) return { isError: true, content: [{ type: 'text', text: 'The session ended.' }] }
      const text = await readFile(answerPath, 'utf8').catch(() => undefined)
      if (text !== undefined) {
        await unlink(answerPath).catch(() => undefined)
        let outcome: SecretOutcome
        try { outcome = JSON.parse(text) as SecretOutcome } catch { outcome = { outcome: 'expired', reason: 'unreadable' } }
        return { isError: outcome.outcome !== 'saved', content: [{ type: 'text', text: secretOutcomeText(ask, outcome) }] }
      }
      await delay(WAIT_MS)
    }
  })
  server.onclose = () => { closed = true }
  process.stdin.once('end', () => { closed = true })
  await server.connect(new StdioServerTransport())
}
