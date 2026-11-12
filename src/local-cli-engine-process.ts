import { join } from 'node:path'

import type { CommandRunner } from './coding-session/agent-env.js'
import { createClaudeStreamState } from './coding-session/claude-adapter.js'
import { createCodexExecTurnState } from './coding-session/codex-exec-events.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import type { Projector } from './coding-session/projection.js'

/**
 * One headless model turn of an installed Claude Code or Codex CLI, with its
 * native tools, MCP servers, history and telemetry switched off. Shared by
 * DeepTest inference grants and the Nessie engines of contract §12; neither
 * reads or copies the CLI's credentials.
 */
export type CliProgram = 'claude' | 'codex'

const MAX_OUTPUT = 16 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  if (Buffer.byteLength(value, 'utf8') > MAX_OUTPUT) throw new Error('OUTPUT_BYTES_LIMIT')
  return value
}
const projector: Projector = { text, line: text, toolInput: () => '', toolResult: () => '', denials: () => [],
  redact: () => undefined, redactSecrets: () => undefined }

/** Keep the native credential authority, while every assessment-bearing Claude sink is disposable. */
export const cliEngineEnvironment = (
  engine: CliProgram, original: NodeJS.ProcessEnv, folder: string,
): NodeJS.ProcessEnv => {
  const env = { ...original }
  const set = (name: string, value: string) => {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key]
    env[name] = value
  }
  for (const key of Object.keys(env)) {
    if (/^(?:CLAUDE|ANTHROPIC)_.*(?:LOG|TRACE|RECORD|DIAGNOSTIC)/iu.test(key)
      || ['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'ENABLE_BETA_TRACING_DETAILED',
        'BETA_TRACING_ENDPOINT', 'OTEL_LOG_RAW_API_BODIES'].includes(key.toUpperCase())) delete env[key]
  }
  set('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1')
  set('DISABLE_TELEMETRY', '1'); set('DISABLE_ERROR_REPORTING', '1'); set('RUST_LOG', 'off')
  if (engine === 'claude') {
    // Native Claude uses this independently for .credentials.json and the macOS keychain service name.
    // Empty means its existing default account; no credential is copied into the disposable config.
    set('CLAUDE_SECURESTORAGE_CONFIG_DIR',
      original.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? original.CLAUDE_CONFIG_DIR ?? '')
    for (const [name, suffix] of [
      ['CLAUDE_CONFIG_DIR', 'claude'], ['CLAUDE_CODE_DEBUG_LOGS_DIR', 'claude-debug.log'],
      ['CLAUDE_CODE_PLUGIN_CACHE_DIR', 'plugins'], ['CLAUDE_CODE_FEDERATION_CACHE_DIR', 'federation'],
      ['XDG_CACHE_HOME', 'cache'], ['CLAUDE_CODE_TMPDIR', 'tmp'], ['CLAUDE_TMPDIR', 'tmp'],
      ['TMPDIR', 'tmp'], ['TMP', 'tmp'], ['TEMP', 'tmp'],
    ]) set(name!, join(folder, suffix!))
    set('CLAUDE_CODE_DISABLE_HOME_SETTINGS_SEED', '1')
    set('CLAUDE_CODE_SKIP_PROMPT_HISTORY', '1')
  }
  return env
}

export type CliTurnOptions = {
  systemPrompt: string
  model?: string
  effort?: 'low' | 'medium' | 'high'
  /** Claude's token-level text deltas, when its help names the flag. */
  partialMessages?: boolean
}

export const cliEngineArguments = (engine: CliProgram, folder: string, options: CliTurnOptions): string[] =>
  engine === 'claude'
    ? ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--safe-mode', '--restricted', '--no-session-persistence',
      '--disable-slash-commands', '--permission-prompts', 'none', '--setting-sources', '',
      '--system-prompt', options.systemPrompt, ...(options.partialMessages ? ['--include-partial-messages'] : []),
      ...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', options.effort] : [])]
    : ['exec', '--strict-config', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '-C', folder, '-c', 'approval_policy="never"',
      '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
      ...['shell_tool', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'browser_use', 'computer_use',
        'skill_search', 'memories', 'sleep_tool', 'tool_suggest', 'goals'].flatMap((flag) => ['-c', `features.${flag}=false`]),
      '-c', 'features.skip_host_skill_discovery=true', '-c', 'analytics.enabled=false',
      '-c', 'history.persistence="none"', '-c', `log_dir=${JSON.stringify(join(folder, 'logs'))}`,
      '-c', `sqlite_home=${JSON.stringify(join(folder, 'state'))}`,
      '-c', 'otel.log_user_prompt=false', '-c', 'otel.exporter="none"', '-c', 'otel.trace_exporter="none"',
      '-c', 'otel.metrics_exporter="none"', ...(options.model ? ['-m', options.model] : []),
      ...(options.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []), '-']

/** A CLI whose help lacks one of these could run its own tools or keep history; it is refused. */
export const cliEngineRequiredFlags = (engine: CliProgram): string[] => engine === 'codex'
  ? ['--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--json']
  : ['--tools', '--strict-mcp-config', '--safe-mode', '--restricted', '--no-session-persistence',
    '--permission-prompts']

/** Help and version, read once per turn; the version is part of the engine's identity. */
export const inspectCliEngine = async (
  engine: CliProgram, program: string, env: NodeJS.ProcessEnv, run: CommandRunner,
): Promise<{ help: string; version: string } | undefined> => {
  const help = await run(program, engine === 'codex' ? ['exec', '--help'] : ['--help'], { env })
  const version = await run(program, ['--version'], { env, maxBytes: 4096 })
  if (help.code !== 0 || version.code !== 0
    || !cliEngineRequiredFlags(engine).every((flag) => help.stdout.includes(flag))) return undefined
  return { help: help.stdout, version: version.stdout.trim() }
}

export type CliTurnResult = { text: string; inputTokens: number | null; outputTokens: number | null }

/**
 * Runs one turn: the prompt on stdin, the CLI's JSON lines on stdout. `onText`
 * hears the reply as the CLI writes it; the resolved text is the CLI's own
 * final answer. Aborting `signal` stops the whole process tree.
 */
export const runCliEngineTurn = async (input: {
  engine: CliProgram; program: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; prompt: string
  signal: AbortSignal; control: CodingProcessControl; onText?: (text: string) => void
}): Promise<CliTurnResult> => {
  const { control, engine } = input
  if (control.refusal || input.signal.aborted) throw new Error('CANCELLED')
  let child: ReturnType<typeof control.spawnAgent> | undefined
  let stopWork: Promise<void> | undefined
  let exited = false
  const stop = () => {
    if (stopWork || !child) return
    stopWork = (async () => { if (!await control.killChildTree(child!)) child!.kill('SIGKILL') })()
  }
  try {
    child = control.spawnAgent(input.program, input.args, { cwd: input.cwd, env: input.env })
    input.signal.addEventListener('abort', stop, { once: true })
    if (input.signal.aborted) stop()
    const codex = createCodexExecTurnState(projector)
    const claude = createClaudeStreamState(projector)
    let response = ''
    let complete = false
    let streamedDeltas = false
    let failure: Error | undefined
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let pending = ''
    let bytes = 0
    const hear = (value: unknown) => { if (typeof value === 'string' && value) input.onText?.(value) }
    const accept = (line: string) => {
      try {
        const parsed = JSON.parse(line) as unknown
        if (!record(parsed)) throw new Error('INFERENCE_INCOMPLETE')
        if (engine === 'codex') {
          // An error item is a notice (Codex 0.167 reports unstable features this way); a failed turn
          // still ends as turn.failed. Any other item is a tool the CLI must never run here.
          if (record(parsed.item) && !['agent_message', 'reasoning', 'error'].includes(String(parsed.item.type))) {
            throw new Error('INFERENCE_INCOMPLETE')
          }
          if (parsed.type === 'item.completed' && record(parsed.item) && parsed.item.type === 'agent_message') {
            hear(parsed.item.text)
          }
          const signals = codex.accept(line)
          if (signals.turnEnded) {
            const result = codex.finish({ code: 0, interrupted: false })
            if (result.isError) throw new Error('INFERENCE_INCOMPLETE')
            response = result.text; complete = true
          }
        } else {
          if (parsed.type === 'stream_event' && record(parsed.event) && record(parsed.event.delta)
            && parsed.event.delta.type === 'text_delta') { streamedDeltas = true; hear(parsed.event.delta.text) }
          if (parsed.type === 'assistant' && !streamedDeltas && record(parsed.message)
            && Array.isArray(parsed.message.content)) {
            for (const block of parsed.message.content) if (record(block) && block.type === 'text') hear(block.text)
          }
          const signals = claude.accept(line)
          if (signals.events.some((event) => event.kind === 'tool' || event.kind === 'tool_result')) {
            throw new Error('INFERENCE_INCOMPLETE')
          }
          if (signals.turnFinished) {
            if (signals.turnFinished.isError) throw new Error('INFERENCE_INCOMPLETE')
            response = signals.turnFinished.text; complete = true
          }
        }
        const usage = record(parsed.usage) ? parsed.usage : undefined
        if (usage && Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0) {
          inputTokens = Number(usage.input_tokens)
        }
        if (usage && Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0) {
          outputTokens = Number(usage.output_tokens)
        }
      } catch (error) { failure ??= error instanceof Error ? error : new Error('INFERENCE_INCOMPLETE'); stop() }
    }
    const closed = new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', resolve)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_OUTPUT) { failure ??= new Error('OUTPUT_BYTES_LIMIT'); stop(); return }
      pending += chunk.toString('utf8')
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline < 0) break
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
        if (line.trim()) accept(line)
      }
    })
    // stderr is drained and discarded: no prompts, native logs or CLI account details persist.
    child.stderr?.resume()
    child.stdin?.on('error', () => undefined)
    child.stdin?.write(input.prompt)
    if (control.endInput) control.endInput(child)
    else child.stdin?.end()
    const code = await closed
    exited = true
    if (pending.trim()) accept(pending)
    if (input.signal.aborted) throw new Error('CANCELLED')
    if (failure) throw failure
    if (code !== 0 || !complete) throw new Error('INFERENCE_INCOMPLETE')
    return { text: response, inputTokens, outputTokens }
  } finally {
    input.signal.removeEventListener('abort', stop)
    if (!exited) stop()
    await stopWork
  }
}
