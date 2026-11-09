import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildAgentEnvironment, runCommand, type CommandRunner } from './coding-session/agent-env.js'
import { createHostProcessControl } from './coding-session/agent-guard.js'
import { loadCodingSessionsConfig } from './coding-session/config.js'
import { resolveProgramPath } from './coding-session/program-path.js'
import { resolveExecutorEntry } from './coding-session/host-spawn.js'
import type { CodingProcessControl } from './coding-session/process-control.js'
import { runsUnderWindowsService } from './coding-session/self-check.js'
import { codingSessionsConfigPath } from './coding-sessions-policy.js'
import { inferenceConfigDigest, type DeepTestInferenceGrant } from './deeptest-inference-grant.js'
import { inferenceModelId, type DeepTestInferenceChat, type DeepTestInferenceResult } from './deeptest-inference-protocol.js'
import type { DeepTestInferenceBackend } from './deeptest-inference-backend.js'
import {
  cliEngineArguments, cliEngineEnvironment, inspectCliEngine, runCliEngineTurn, type CliProgram,
} from './local-cli-engine-process.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

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

const SYSTEM_PROMPT = 'Answer only from the supplied conversation. Native tools and filesystem access are disabled.'

export const codingInferenceArguments = (
  engine: CliProgram, folder: string, model?: string, effort?: 'low' | 'medium' | 'high',
): string[] => cliEngineArguments(engine, folder, {
  systemPrompt: SYSTEM_PROMPT, ...(model ? { model } : {}), ...(effort ? { effort } : {}),
})

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
      const inspected = await inspectCliEngine(engine, program, env, run)
      const auth = await run(program, engine === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { env })
      if (!inspected || auth.code !== 0) throw new Error('UNSUPPORTED_CAPABILITY')
      if (engine === 'claude') {
        let status: unknown
        try { status = JSON.parse(auth.stdout) as unknown } catch { throw new Error('INFERENCE_UNAVAILABLE') }
        if (!record(status) || status.loggedIn !== true) throw new Error('INFERENCE_UNAVAILABLE')
      }
      const nativeModel = agent.model ?? 'default'
      return { agent, env, program, nativeModel, help: inspected.help, digest: inferenceConfigDigest({
        engine, nativeModel, program, version: inspected.version, grant: grant.codingConfigDigest,
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
        try {
          if (control.refusal || signal.aborted) throw new Error('CANCELLED')
          await mkdir(join(folder, 'tmp'), { mode: 0o700 })
          const env = cliEngineEnvironment(engine, selected.env, folder)
          if (engine === 'claude') {
            // This also refuses older CLIs that cannot read the original account separately from configHome.
            const auth = await (dependencies.run ?? runCommand)(selected.program,
              ['--safe-mode', 'auth', 'status', '--json'], { cwd: folder, env })
            let status: unknown
            try { status = JSON.parse(auth.stdout) as unknown } catch { throw new Error('INFERENCE_UNAVAILABLE') }
            if (auth.code !== 0 || !record(status) || status.loggedIn !== true) throw new Error('INFERENCE_UNAVAILABLE')
          }
          const turn = await runCliEngineTurn({ engine, program: selected.program, env, cwd: folder, signal, control,
            args: codingInferenceArguments(engine, folder, selected.agent.model, request.reasoning_effort),
            prompt: codingInferencePrompt(request) })
          const checked = await configured()
          if (checked.digest !== selected.digest) throw new Error('MODEL_CHANGED')
          return { model_id: request.model_id, model_digest: request.model_digest,
            ...codingInferenceResult(request, turn.text), reasoning: null,
            usage: { input_tokens: turn.inputTokens, output_tokens: turn.outputTokens } }
        } finally {
          await rm(folder, { recursive: true, force: true })
        }
      },
    }
  }
  return backends
}
