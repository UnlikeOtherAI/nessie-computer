import type { PathRewriter } from './path-rewrite.js'
import type { CodingPermissionDenial } from './types.js'

/**
 * The field allowlist every agent event passes through before it is written.
 *
 * Each kind keeps a fixed set of fields at a fixed size, every string goes
 * through the path rewriter, and nothing else survives: init's `cwd`,
 * `memory_paths` and `mcp_servers`, rate-limit state, sockets and the
 * initialize `account` are never read into a projected event at all.
 *
 * The model itself knows who is logged in, though, and repeats it: a live
 * Claude Code turn typed the account's e-mail into a `git config` command.
 * So the account's own e-mail and organisation are redactions, held in this
 * process's memory only, and every later string spells them `<account>`.
 * The rewriter then hides paths, and after them the OS user and host names as
 * `<user>` and `<host>` (git printed `ondre@Minis.(none)` in the same run).
 *
 * Credentials are scrubbed before anything else, and read `<secret>`: the
 * values the host gave the agent (every `agentEnv.set` value, and every
 * inherited variable whose name says it is a credential), and anything shaped
 * like a GitHub, Anthropic, OpenAI, Slack or AWS key, a JWT, a bearer header,
 * a private key block or a `NAME=value` whose name says credential.
 */
export const ACCOUNT_PLACEHOLDER = '<account>'
export const SECRET_PLACEHOLDER = '<secret>'
export const CODING_EVENT_LIMITS = {
  assistant: 2_000,
  user: 2_000,
  tool: 300,
  toolResult: 300,
  toolError: 1_000,
  result: 4_000,
  system: 1_000,
} as const

export type Projector = {
  /** Rewritten and capped, newlines kept (assistant prose, results). */
  text: (value: unknown, max: number) => string
  /** Rewritten, collapsed to one line and capped (summaries). */
  line: (value: unknown, max: number) => string
  toolInput: (tool: string, input: unknown) => string
  toolResult: (content: unknown, isError: boolean) => string
  denials: (value: unknown) => CodingPermissionDenial[]
  /** Values every later string spells `<account>`; anything but a string of four or more characters is ignored. */
  redact: (values: readonly unknown[]) => void
  /** Values every later string spells `<secret>`; anything shorter than eight characters is ignored. */
  redactSecrets: (values: readonly unknown[]) => void
}

const MIN_REDACTION_LENGTH = 4
const MIN_SECRET_LENGTH = 8

/** Environment variable names whose values are credentials by convention. */
export const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/iu

/**
 * Token shapes that are credentials wherever they appear. A coding agent runs
 * `gh auth token`, `printenv` or `cat .env`, or pastes a header into `curl`,
 * and the command and its output would otherwise land in the events verbatim.
 */
const SECRET_PATTERNS: { pattern: RegExp; replace: string }[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    replace: SECRET_PLACEHOLDER,
  },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, replace: SECRET_PLACEHOLDER },
  { pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu, replace: SECRET_PLACEHOLDER },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, replace: SECRET_PLACEHOLDER },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, replace: SECRET_PLACEHOLDER },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, replace: SECRET_PLACEHOLDER },
  { pattern: /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{16,}/giu, replace: `$1$2${SECRET_PLACEHOLDER}` },
  {
    // NAME=value, NAME: value and "name": "value", where the name says it is a credential.
    pattern: new RegExp(
      `\\b([A-Za-z0-9_]*${SECRET_NAME.source}[A-Za-z0-9_]*)(["']?\\s*[=:]\\s*)("[^"\\n]{6,}"|'[^'\\n]{6,}'|[^\\s"',;]{6,})`,
      'giu',
    ),
    replace: `$1$2${SECRET_PLACEHOLDER}`,
  },
]

const valuePattern = (values: ReadonlySet<string>): RegExp | undefined => {
  if (values.size === 0) return undefined
  // Longest first, so a value that contains another is replaced whole.
  const alternatives = [...values].sort((left, right) => right.length - left.length).map(escapeRegExp)
  return new RegExp(alternatives.join('|'), 'giu')
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const clip = (value: string, max: number): string => (
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
)

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const firstString = (input: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/** What a tool call was about, in one line: the field a person would glance at. */
const toolSubject = (tool: string, input: unknown): string => {
  if (!record(input)) return ''
  if (['Bash', 'PowerShell', 'shell', 'command_execution'].includes(tool)) return firstString(input, ['command']) ?? ''
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return firstString(input, ['file_path', 'notebook_path', 'path']) ?? ''
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const pattern = firstString(input, ['pattern']) ?? ''
    const where = firstString(input, ['path'])
    return where ? `${pattern} in ${where}` : pattern
  }
  if (tool === 'WebFetch') return firstString(input, ['url']) ?? ''
  if (tool === 'WebSearch') return firstString(input, ['query']) ?? ''
  if (tool === 'Task' || tool === 'Agent') return firstString(input, ['description', 'subagent_type']) ?? ''
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} items`
  const fallback = Object.values(input).find((value) => typeof value === 'string' && value.trim())
  return typeof fallback === 'string' ? fallback : Object.keys(input).slice(0, 6).join(', ')
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => (
    record(block) && typeof block.text === 'string' ? block.text : ''
  )).filter(Boolean).join(' ')
}

export const createProjector = (rewriter: PathRewriter): Projector => {
  let redactions: RegExp | undefined
  let secretValues: RegExp | undefined
  const secrets = new Set<string>()
  // Credentials first (known values, then known shapes), then the account, then paths, user and host.
  const scrub = (value: string): string => {
    let current = secretValues ? value.replace(secretValues, SECRET_PLACEHOLDER) : value
    for (const { pattern, replace } of SECRET_PATTERNS) current = current.replace(pattern, replace)
    return rewriter.rewrite(redactions ? current.replace(redactions, ACCOUNT_PLACEHOLDER) : current)
  }
  const text = (value: unknown, max: number): string => (
    typeof value === 'string' ? clip(scrub(value).trim(), max) : ''
  )
  const line = (value: unknown, max: number): string => (
    typeof value === 'string' ? clip(scrub(value).replace(/\s+/gu, ' ').trim(), max) : ''
  )
  const redacted = new Set<string>()
  return {
    redact: (values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length >= MIN_REDACTION_LENGTH) redacted.add(value.trim())
      }
      // Longest first, so an organisation named after the e-mail is redacted whole.
      redactions = valuePattern(redacted)
    },
    redactSecrets: (values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH) secrets.add(value.trim())
      }
      secretValues = valuePattern(secrets)
    },
    text,
    line,
    toolInput: (tool, input) => line(toolSubject(tool, input), CODING_EVENT_LIMITS.tool),
    toolResult: (content, isError) => line(
      resultText(content), isError ? CODING_EVENT_LIMITS.toolError : CODING_EVENT_LIMITS.toolResult,
    ),
    denials: (value) => {
      if (!Array.isArray(value)) return []
      return value.slice(0, 20).flatMap((entry: unknown) => {
        if (!record(entry)) return []
        const tool = typeof entry.tool_name === 'string' ? entry.tool_name : typeof entry.tool === 'string' ? entry.tool : ''
        if (!tool) return []
        return [{ tool: line(tool, 80), summary: line(toolSubject(tool, entry.tool_input), CODING_EVENT_LIMITS.tool) }]
      })
    },
  }
}

// Structural, not linguistic: which program a shell command runs. The review
// reports "the last test command and its exit code", and this is how a command
// is recognised as one.
const TEST_COMMAND = new RegExp(
  '(?:^|[\\s;&|(])(?:(?:pnpm|npm|yarn|bun)\\b[^;&|]*\\s(?:run\\s+)?test(?::[\\w:-]+)?\\b'
  + '|(?:vitest|jest|pytest|mocha|rspec|phpunit)\\b|(?:go|cargo|dotnet|mvn|swift)\\s+test\\b'
  + '|node\\s+(?:[^;&|]*\\s)?--test\\b|playwright\\s+test\\b)',
  'u',
)

export const looksLikeTestCommand = (command: string): boolean => TEST_COMMAND.test(command)

/** `Exit code 3` is how Claude Code reports a failed Bash command in its tool result. */
export const exitCodeFromToolResult = (content: unknown, isError: boolean): number | null => {
  if (!isError) return 0
  const match = /Exit code (\d{1,3})\b/u.exec(resultText(content))
  return match ? Number(match[1]) : null
}
