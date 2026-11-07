import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentEnvironment, runCommand, type CommandRunner } from './coding-session/agent-env.js'
import { createHostProcessControl } from './coding-session/agent-guard.js'
import { createCodexExecTurnState } from './coding-session/codex-exec-events.js'
import { createClaudeStreamState } from './coding-session/claude-adapter.js'
import { loadCodingSessionsConfig } from './coding-session/config.js'
import { resolveProgramPath } from './coding-session/program-path.js'
import { resolveExecutorEntry } from './coding-session/host-spawn.js'
import type { Projector } from './coding-session/projection.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import { runsUnderWindowsService } from './coding-session/self-check.js'
import { codingSessionsConfigPath } from './coding-sessions-policy.js'
import { inferenceConfigDigest, type DeepTestInferenceGrant } from './deeptest-inference-grant.js'
import { inferenceModelId, type DeepTestInferenceChat, type DeepTestInferenceResult } from './deeptest-inference-protocol.js'
import type { DeepTestInferenceBackend } from './deeptest-inference-backend.js'

const MAX_OUTPUT = 16 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  if (Buffer.byteLength(value, 'utf8') > MAX_OUTPUT) throw new Error('OUTPUT_BYTES_LIMIT')
  return value
}
const projector: Projector = { text, line: text, toolInput: () => '', toolResult: () => '', denials: () => [],
  redact: () => undefined, redactSecrets: () => undefined }

/** Keep the native credential authority, while every assessment-bearing Claude sink is disposable. */
export const codingInferenceEnvironment = (
  engine: 'codex' | 'claude', original: NodeJS.ProcessEnv, folder: string,
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

/** A tool proposal is data for DeepTest to authorize, never a native CLI tool. */
export const codingInferencePrompt = (request: DeepTestInferenceChat): string => [
  'You are an inference engine for an authorized DeepTest assessment. Work only from the conversation supplied below.',
  'Do not inspect files, execute commands, edit code, use native tools, or access other sessions.',
  request.tools.length ? 'Return exactly one JSON object: {"content":string|null,"tool_calls":[{"toolName":string,"arguments":object}]}. Only propose supplied tool names; DeepTest executes them separately.'
    : 'Return the assistant response as plain text.',
  'The following JSON contains the complete conversation and available application tool descriptions:',
  JSON.stringify({ messages: request.messages, tools: request.tools }),
].join('\n\n')

export const codingInferenceResult = (
  request: DeepTestInferenceChat, response: string,
): Pick<DeepTestInferenceResult, 'content' | 'tool_calls' | 'finish_reason'> => {
  if (!request.tools.length) return { content: response || null, tool_calls: [], finish_reason: 'stop' }
  let body: unknown
  try { body = JSON.parse(response) as unknown } catch { throw new Error('INFERENCE_INCOMPLETE') }
  if (!record(body) || Object.keys(body).some((key) => !['content', 'tool_calls'].includes(key))
    || body.content !== null && typeof body.content !== 'string' || !Array.isArray(body.tool_calls)
    || body.tool_calls.length > 128) throw new Error('INFERENCE_INCOMPLETE')
  const tool_calls = body.tool_calls.map((call, index) => {
    if (!record(call) || Object.keys(call).some((key) => !['toolName', 'arguments'].includes(key))
      || typeof call.toolName !== 'string' || !request.tools.some((tool) => tool.toolName === call.toolName)
      || !record(call.arguments)) throw new Error('INFERENCE_INCOMPLETE')
    return { toolCallId: `${request.request_id}:cli-${index + 1}`, toolName: call.toolName, arguments: call.arguments }
  })
  return { content: body.content, tool_calls, finish_reason: tool_calls.length ? 'tool-call' : 'stop' }
}

export const codingInferenceArguments = (
  engine: 'codex' | 'claude', folder: string, model?: string, effort?: 'low' | 'medium' | 'high',
): string[] =>
  engine === 'claude'
    ? ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--safe-mode', '--restricted', '--no-session-persistence',
      '--disable-slash-commands', '--permission-prompts', 'none', '--setting-sources', '',
      '--system-prompt', 'Answer only from the supplied conversation. Native tools and filesystem access are disabled.',
      ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])]
    : ['exec', '--strict-config', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '-C', folder, '-c', 'approval_policy="never"',
      '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
      ...['shell_tool', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'browser_use', 'computer_use',
        'skill_search', 'memories', 'sleep_tool', 'tool_suggest', 'goals'].flatMap((flag) => ['-c', `features.${flag}=false`]),
      '-c', 'features.skip_host_skill_discovery=true', '-c', 'analytics.enabled=false',
      '-c', 'history.persistence="none"', '-c', `log_dir=${JSON.stringify(join(folder, 'logs'))}`,
      '-c', `sqlite_home=${JSON.stringify(join(folder, 'state'))}`,
      '-c', 'otel.log_user_prompt=false', '-c', 'otel.exporter="none"', '-c', 'otel.trace_exporter="none"',
      '-c', 'otel.metrics_exporter="none"', ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-']

const requiredFlags = (engine: 'codex' | 'claude') => engine === 'codex'
  ? ['--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--json']
  : ['--tools', '--strict-mcp-config', '--safe-mode', '--restricted', '--no-session-persistence', '--permission-prompts']

export const createDeepTestCodingBackends = async (
  stateDir: string, grant: DeepTestInferenceGrant,
  dependencies: { run?: CommandRunner; control?: CodingProcessControl } = {},
): Promise<Partial<Record<'codex' | 'claude', DeepTestInferenceBackend>>> => {
  const backends: Partial<Record<'codex' | 'claude', DeepTestInferenceBackend>> = {}
  if (!grant.engines.some((engine) => engine === 'codex' || engine === 'claude')) return backends
  const read = async () => {
    const loaded = await loadCodingSessionsConfig(codingSessionsConfigPath(stateDir))
    if (inferenceConfigDigest(loaded.config) !== grant.codingConfigDigest) throw new Error('GRANT_REVOKED')
    return loaded.config
  }
  for (const engine of ['codex', 'claude'] as const) {
    if (!grant.engines.includes(engine)) continue
    const configured = async () => {
      const config = await read()
      const agent = config.agents[engine]
      // Arbitrary argv or a shell wrapper could supersede the fixed inference restrictions.
      if (!agent || agent.command.length !== 1 || agent.args.length) throw new Error('UNSUPPORTED_CAPABILITY')
      const env = await buildAgentEnvironment({ config: config.agentEnv })
      if (await runsUnderWindowsService({ received: env })) throw new Error('UNSUPPORTED_CAPABILITY')
      const program = await resolveProgramPath(agent.command[0]!, env)
      if (!program) throw new Error('INFERENCE_UNAVAILABLE')
      const run = dependencies.run ?? runCommand
      const help = await run(program, engine === 'codex' ? ['exec', '--help'] : ['--help'], { env })
      const version = await run(program, ['--version'], { env, maxBytes: 4096 })
      const auth = await run(program, engine === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { env })
      if (help.code !== 0 || version.code !== 0 || auth.code !== 0
        || !requiredFlags(engine).every((flag) => help.stdout.includes(flag))) throw new Error('UNSUPPORTED_CAPABILITY')
      if (engine === 'claude') {
        let status: unknown
        try { status = JSON.parse(auth.stdout) as unknown } catch { throw new Error('INFERENCE_UNAVAILABLE') }
        if (!record(status) || status.loggedIn !== true) throw new Error('INFERENCE_UNAVAILABLE')
      }
      const nativeModel = agent.model ?? 'default'
      return { agent, env, program, nativeModel, help: help.stdout, digest: inferenceConfigDigest({
        engine, nativeModel, program, version: version.stdout.trim(), grant: grant.codingConfigDigest,
        protocol: 'deeptest-inference-cli-v2',
      }) }
    }
    backends[engine] = {
      models: async () => {
        const selected = await configured()
        return [{ id: inferenceModelId(engine, selected.nativeModel), label: `${engine}: ${selected.nativeModel}`, engine,
          model_digest: selected.digest, context_length: null, max_output_tokens: null, capabilities: ['text', 'tools'] }]
      },
      chat: async (request, signal) => {
        const selected = await configured()
        if (request.model_id !== inferenceModelId(engine, selected.nativeModel)
          || request.model_digest !== selected.digest) {
          throw new Error('MODEL_CHANGED')
        }
        // Neither CLI exposes a reliable per-call output cap; never silently drop an explicit request.
        if (request.max_output_tokens !== undefined || request.thinking) throw new Error('UNSUPPORTED_CAPABILITY')
        if (engine === 'claude' && request.reasoning_effort && !selected.help.includes('--effort')) {
          throw new Error('UNSUPPORTED_CAPABILITY')
        }
        const folder = await mkdtemp(join(tmpdir(), 'nessie-deeptest-inference-'))
        const control = dependencies.control
          ?? createHostProcessControl(resolveExecutorEntry(), { environment: process.env })
        if (control.refusal || signal.aborted) { await rm(folder, { recursive: true, force: true }); throw new Error('CANCELLED') }
        let child: ReturnType<typeof control.spawnAgent> | undefined
        let stopped = false
        let stopWork: Promise<void> | undefined
        const stop = () => {
          if (stopWork || !child) return
          stopWork = (async () => { if (!await control.killChildTree(child!)) child!.kill('SIGKILL') })()
        }
        try {
          await mkdir(join(folder, 'tmp'), { mode: 0o700 })
          const env = codingInferenceEnvironment(engine, selected.env, folder)
          if (engine === 'claude') {
            // This also refuses older CLIs that cannot read the original account separately from configHome.
            const auth = await (dependencies.run ?? runCommand)(selected.program,
              ['--safe-mode', 'auth', 'status', '--json'], { cwd: folder, env })
            let status: unknown
            try { status = JSON.parse(auth.stdout) as unknown } catch { throw new Error('INFERENCE_UNAVAILABLE') }
            if (auth.code !== 0 || !record(status) || status.loggedIn !== true) throw new Error('INFERENCE_UNAVAILABLE')
          }
          if (signal.aborted) throw new Error('CANCELLED')
          const args = codingInferenceArguments(engine, folder, selected.agent.model, request.reasoning_effort)
          child = control.spawnAgent(selected.program, args, { cwd: folder, env })
          signal.addEventListener('abort', stop, { once: true })
          if (signal.aborted) stop()
          const codex = createCodexExecTurnState(projector)
          const claude = createClaudeStreamState(projector)
          let response = ''
          let complete = false
          let failure: Error | undefined
          let inputTokens: number | null = null
          let outputTokens: number | null = null
          let pending = ''
          let bytes = 0
          const accept = (line: string) => {
            try {
              const parsed = JSON.parse(line) as unknown
              if (!record(parsed)) throw new Error('INFERENCE_INCOMPLETE')
              if (engine === 'codex') {
                if (record(parsed.item) && !['agent_message', 'reasoning'].includes(String(parsed.item.type))) {
                  throw new Error('INFERENCE_INCOMPLETE')
                }
                const signals = codex.accept(line)
                if (signals.turnEnded) {
                  const result = codex.finish({ code: 0, interrupted: false })
                  if (result.isError) throw new Error('INFERENCE_INCOMPLETE')
                  response = result.text; complete = true
                }
              } else {
                const signals = claude.accept(line)
                if (signals.events.some((event) => event.kind === 'tool' || event.kind === 'tool_result')) throw new Error('INFERENCE_INCOMPLETE')
                if (signals.turnFinished) {
                  if (signals.turnFinished.isError) throw new Error('INFERENCE_INCOMPLETE')
                  response = signals.turnFinished.text; complete = true
                }
              }
              const usage = record(parsed.usage) ? parsed.usage : undefined
              for (const [key, setter] of [
                ['input_tokens', (value: number) => { inputTokens = value }],
                ['output_tokens', (value: number) => { outputTokens = value }],
              ] as const) {
                if (usage && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0) setter(Number(usage[key]))
              }
            } catch (error) { failure = error instanceof Error ? error : new Error('INFERENCE_INCOMPLETE'); stop() }
          }
          const exited = new Promise<number | null>((resolve, reject) => {
            child!.once('error', reject)
            child!.once('close', resolve)
          })
          child.stdout?.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength
            if (bytes > MAX_OUTPUT) { failure = new Error('OUTPUT_BYTES_LIMIT'); stop(); return }
            pending += chunk.toString('utf8')
            for (;;) {
              const newline = pending.indexOf('\n')
              if (newline < 0) break
              const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
              if (line.trim()) accept(line)
            }
          })
          // stderr is drained and discarded: no assessment prompts, native logs or CLI account details persist.
          child.stderr?.resume()
          child.stdin?.on('error', () => undefined)
          child.stdin?.write(codingInferencePrompt(request))
          if (control.endInput) control.endInput(child)
          else child.stdin?.end()
          const code = await exited
          stopped = true
          if (pending.trim()) accept(pending)
          if (failure) throw failure
          if (signal.aborted) throw new Error('CANCELLED')
          if (code !== 0 || !complete) throw new Error('INFERENCE_INCOMPLETE')
          const checked = await configured()
          if (checked.digest !== selected.digest) throw new Error('MODEL_CHANGED')
          return { model_id: request.model_id, model_digest: request.model_digest,
            ...codingInferenceResult(request, response), reasoning: null,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
        } finally {
          signal.removeEventListener('abort', stop)
          if (!stopped) stop()
          await stopWork
          await rm(folder, { recursive: true, force: true })
        }
      },
    }
  }
  return backends
}
