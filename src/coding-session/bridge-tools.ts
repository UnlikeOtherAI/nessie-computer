import { offeredCodingAgents, type LoadedCodingSessionsConfig } from './config.js'
import { CODING_SESSION_ID_PATTERN } from './types.js'

/**
 * The bridge's tool catalogue. The worker (not this server) owns the
 * descriptions a model is shown for its first-class coding tools; these are
 * for a person reading `mcp.tools`, and the input schemas are real so scalar
 * coercion works. `session_close_all` and `session_list_all` are deliberately
 * not listed: they are the daemon's own teardown and heartbeat-report calls,
 * refused without its reserved `_meta` marker.
 */

const sessionIdSchema = { type: 'string' as const, pattern: CODING_SESSION_ID_PATTERN.source }

/**
 * A pull request `session_review` may be asked about by URL: github.com, an
 * owner (1 to 39 letters, digits and inner hyphens), a repository, and a
 * number — nothing after it, no other host, no query. It becomes an argv
 * entry of `gh pr view`, which it can never be read as an option of, since it
 * starts with `https://`.
 */
const GITHUB_OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
const GITHUB_REPOSITORY = '(?!\\.{1,2}/)[A-Za-z0-9._-]{1,100}'
export const GITHUB_PULL_REQUEST_URL = new RegExp(
  `^https://github\\.com/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pull/[1-9][0-9]{0,9}$`, 'u',
)
export const PULL_REQUEST_URL_MAX = 200

export const codingBridgeTools = (loaded: LoadedCodingSessionsConfig) => {
  const agents = offeredCodingAgents(loaded.config)
  const roots = loaded.config.roots.map((root) => root.name)
  const session = (description: string, name: string) => ({
    name, description,
    inputSchema: {
      type: 'object' as const, additionalProperties: false, required: ['sessionId'],
      properties: { sessionId: sessionIdSchema },
    },
  })
  return [
    ...(['queue', 'push', 'steer'] as const).map((action) => ({
      name: `session_${action}`, description: `Existing native session ${action}; inspect its capabilities first.`,
      inputSchema: { type: 'object' as const, additionalProperties: false,
        required: action === 'steer' ? ['sessionId', 'message', 'expectedTurnId'] : ['sessionId', 'message'],
        properties: { sessionId: sessionIdSchema, message: { type: 'string', minLength: 1, maxLength: 32_000 },
          ...(action === 'steer' ? { expectedTurnId: { type: 'string', maxLength: 128 } } : {}) } },
    })),
    {
      name: 'session_list',
      description: 'List the folders and coding agents this machine offers, and your own coding sessions.',
      inputSchema: { type: 'object' as const, additionalProperties: false, properties: {
        provider: { type: 'string', enum: ['codex', 'claude'] }, cursor: { type: 'string', maxLength: 1_024 },
        search: { type: 'string', maxLength: 200 },
      } },
    },
    {
      name: 'session_start',
      description: 'Start a coding agent on this machine with a task (root and prompt) in one of its folders, or a '
        + 'terminal running a command this computer\'s command rules permit (command, and cwd or the home folder). '
        + 'Returns at once; poll session_status to follow it.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['agent'],
        properties: {
          agent: { type: 'string', enum: agents },
          root: { type: 'string', enum: roots },
          path: { type: 'string', maxLength: 1_000, description: 'A folder inside the root; the root itself when absent.' },
          prompt: { type: 'string', maxLength: 32_000 },
          command: {
            type: 'array', minItems: 1, maxItems: 65, items: { type: 'string', maxLength: 4_096 },
            description: 'terminal only: the program, then each argument. Nothing is parsed by a shell.',
          },
          cwd: { type: 'string', maxLength: 4_096, description: 'terminal only: an absolute folder.' },
          title: { type: 'string', maxLength: 120 },
        },
      },
    },
    {
      name: 'session_status',
      description: 'What a session is doing now, and what happened since you last asked. Never waits.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['sessionId'],
        properties: {
          sessionId: sessionIdSchema,
          detail: { type: 'string', enum: ['summary', 'events'] },
          cursor: { type: 'string', maxLength: 64 },
        },
      },
    },
    {
      name: 'session_send',
      description: 'Send a follow-up or a correction. A working session reads it at its next step.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['sessionId', 'message'],
        properties: {
          sessionId: sessionIdSchema, message: { type: 'string', minLength: 1, maxLength: 32_000 },
          terminal: { type: 'boolean' },
        },
      },
    },
    session('Stop the current turn. The session stays open and can be sent a new message.', 'session_interrupt'),
    {
      name: 'session_review',
      description: 'What the session actually changed: branch, commits, diff, worktrees and pull requests. Name a '
        + 'pull request to be told its state even after its branch was merged and deleted.',
      inputSchema: {
        type: 'object' as const, additionalProperties: false, required: ['sessionId'],
        properties: {
          sessionId: sessionIdSchema,
          pullRequest: { type: 'string', pattern: GITHUB_PULL_REQUEST_URL.source, maxLength: PULL_REQUEST_URL_MAX },
        },
      },
    },
    session('End the session and every process it started. Its history stays readable.', 'session_close'),
    session('Read the current interactive terminal screen as text.', 'terminal_read'),
  ]
}

export class CodingBridgeError extends Error {
  override readonly name = 'CodingBridgeError'
  constructor(readonly code: string, message: string) { super(message) }
}

export const invalidArguments = (message: string): never => {
  throw new CodingBridgeError('coding_session_invalid_arguments', message)
}

/** The model's arguments, refusing any key the tool does not define. */
export const argumentsFor = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  const args = value ?? {}
  if (typeof args !== 'object' || Array.isArray(args)) return invalidArguments('Arguments must be an object.')
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) invalidArguments(`Unknown argument: ${unknown[0]!.slice(0, 40)}.`)
  return args as Record<string, unknown>
}

export const requiredText = (value: unknown, name: string, maxLength: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    return invalidArguments(`${name} must be text of at most ${maxLength} characters.`)
  }
  return value
}

export const pullRequestArgument = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > PULL_REQUEST_URL_MAX || !GITHUB_PULL_REQUEST_URL.test(value)) {
    return invalidArguments(
      'pullRequest must be a GitHub pull request URL, such as https://github.com/owner/repo/pull/123.',
    )
  }
  return value
}

export const sessionIdArgument = (value: unknown): string => {
  if (typeof value !== 'string' || !CODING_SESSION_ID_PATTERN.test(value)) {
    throw new CodingBridgeError('coding_session_not_found', 'No such session.')
  }
  return value
}
