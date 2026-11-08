import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDeepTestInferenceAdapter } from '../src/deeptest-inference-adapter.js'
import { createDeepTestLocalBackend } from '../src/deeptest-inference-backend.js'
import { codingInferenceArguments, codingInferencePrompt, codingInferenceResult,
  createDeepTestCodingBackends } from '../src/deeptest-inference-coding.js'
import { cliEngineEnvironment as codingInferenceEnvironment } from '../src/local-cli-engine-process.js'
import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { DEEPTEST_INFERENCE_GRANT_FILE, currentInferenceConfig, loadDeepTestInferenceGrant,
  parseDeepTestInferenceGrant, publishDeepTestInferenceGrant, revokeDeepTestInferenceGrant, inferenceConfigDigest,
  type DeepTestInferenceGrant } from '../src/deeptest-inference-grant.js'
import { inferenceModelId, parseDeepTestInferenceRequest, type DeepTestInferenceChat } from '../src/deeptest-inference-protocol.js'
import { parseCommand } from '../src/cli-arguments.js'
import { saveLocalOpenAiConfig } from '../src/openai-local-config.js'
import { clearExecutorState, saveExecutorState } from '../src/state-store.js'
import { normalizeCodingSessionsConfig } from '../src/coding-session/config.js'
import { ensureOwnerOnlyStateDirectory } from '../src/state-security.js'
import { streamOllamaChat } from '../src/ollama-chat.js'
import { createOllamaBackend } from '../src/local-inference-backend.js'
import { WINDOWS_STATE_HELPER_SKIP } from './windows-prerequisites.js'

const grant: DeepTestInferenceGrant = { executorId: '00000000-0000-4000-8000-000000000005', engines: ['ollama'] }
const binding = { account_id: 'account.test', project_id: 'project.test', review_id: 'review.test', session_id: 'session.test' }
const frame = (operation: string, extra: Record<string, unknown> = {}) => ({
  ...binding, protocol_version: 1, request_id: operation.replace('.', '_'), operation, ...extra,
})
const chat = (extra: Record<string, unknown> = {}): DeepTestInferenceChat => parseDeepTestInferenceRequest(frame('inference.chat', {
  model_id: inferenceModelId('ollama', 'qwen3.8:27b'), model_digest: 'a'.repeat(64),
  messages: [{ role: 'user', content: 'Synthetic authorized review context' }], tools: [], ...extra,
})) as DeepTestInferenceChat
const result = { model_id: inferenceModelId('ollama', 'qwen3.8:27b'), model_digest: 'a'.repeat(64),
  content: 'Reviewed', reasoning: null, tool_calls: [], finish_reason: 'stop' as const,
  usage: { input_tokens: 1, output_tokens: 1 } }

test('native grammar is closed and requires a separate bound hello before any inference', async () => {
  let calls = 0
  const adapter = createDeepTestInferenceAdapter(grant, async () => grant, { ollama: {
    models: async () => [], chat: async () => { calls += 1; return result },
  } })
  assert.equal((await adapter.dispatch(chat())).status, 'error')
  assert.equal((await adapter.dispatch(frame('hello'))).status, 'ok')
  const cross = await adapter.dispatch(chat({ account_id: 'different' }))
  assert.equal(cross.status === 'error' && cross.error.code, 'BINDING_MISMATCH')
  for (const extra of [{ endpoint: 'https://unapproved.test' }, { api_key: 'secret' }, { command: ['sh'] },
    { messages: [{ role: 'user', content: [{ type: 'image', imageUrl: 'https://unapproved.test' }] }] },
    { messages: [{ role: 'user', content: 'text', cwd: '/private' }] },
    { tools: [{ toolName: 'read', description: 'read', inputSchema: {}, execute: 'native' }] }]) {
    assert.throws(() => chat(extra), /REQUEST_INVALID/u)
  }
  assert.equal(calls, 0)
  assert.equal((await adapter.dispatch(chat())).status, 'ok')
  assert.equal((await adapter.dispatch(chat())).status, 'error', 'same process never redispatches a request id')
  assert.equal(calls, 1)
  adapter.close()
})

test('revocation, changed context and transport closure abort an active backend before returning success', async () => {
  for (const cause of ['revoked', 'context_changed', 'closed']) {
    let allowed = true
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    const adapter = createDeepTestInferenceAdapter(grant, async () => {
      if (!allowed && cause !== 'context_changed') throw new Error('withdrawn')
      return cause === 'context_changed' && !allowed ? { ...grant, ollamaContextLength: 32768 } : grant
    }, { ollama: { models: async () => [], chat: async (_request, signal) => {
      started()
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return result
    } } })
    await adapter.dispatch(frame('hello'))
    const running = adapter.dispatch(chat())
    await began
    if (cause === 'revoked' || cause === 'context_changed') allowed = false
    else adapter.close()
    const answer = await running
    assert.equal(answer.status === 'error' && answer.error.code, cause !== 'closed' ? 'GRANT_REVOKED' : 'CANCELLED')
    adapter.close()
  }
})

test('local inference reuses the selected backend, preserves tool usage, and has no implicit output ceiling', async () => {
  let observed = 0
  const backend = createDeepTestLocalBackend('ollama', {
    observe: async () => { observed += 1; return [{ name: 'qwen3.8:27b', manifestDigest: 'a'.repeat(64),
      capabilities: ['completion', 'tools'], numCtxCap: 262144, remoteHost: null, remoteModel: null, sizeBytes: null }] },
    stream: async function* (input) {
      assert.equal(input.attempt.maxOutputTokens, undefined)
      assert.equal(input.attempt.numCtx, 262144)
      assert.equal(input.useModelDefaultContext, true, 'architectural capacity must not force a physical KV allocation')
      assert.equal(input.attempt.messages[0]?.content, 'Synthetic authorized review context')
      assert.equal(input.origin, 'http://127.0.0.1:11434')
      yield { done: false, text: 'Examined' }
      yield { done: true, toolCalls: [{ toolCallId: 'tool1', toolName: 'read', arguments: { path: 'app.ts' } }],
        finishReason: 'tool-call', inputTokens: 3, outputTokens: 2 }
    },
  })
  const answer = await backend.chat(chat({ tools: [{ toolName: 'read', description: 'Read approved source', inputSchema: {} }] }), new AbortController().signal)
  assert.equal(answer.finish_reason, 'tool-call')
  assert.deepEqual(answer.usage, { input_tokens: 3, output_tokens: 2 })
  assert.deepEqual(answer.tool_calls[0]?.arguments, { path: 'app.ts' })
  assert.equal(observed, 2)
})

test('streamed tool proposals survive an empty terminal stop without hiding physical limits', async () => {
  for (const finishReason of ['stop', 'length', 'other'] as const) {
    const backend = createDeepTestLocalBackend('ollama', {
      observe: async () => [{ name: 'qwen3.8:27b', manifestDigest: 'a'.repeat(64),
        capabilities: ['completion', 'tools'], numCtxCap: 262144, remoteHost: null, remoteModel: null, sizeBytes: null }],
      stream: async function* () {
        yield { done: false, toolCalls: [{ toolCallId: 'tool1', toolName: 'lookup_marker', arguments: { key: 'test' } }] }
        yield { done: true, finishReason, inputTokens: 3, outputTokens: 2 }
      },
    })
    const answer = await backend.chat(chat({ tools: [{ toolName: 'lookup_marker', description: 'Synthetic lookup', inputSchema: {} }] }),
      new AbortController().signal)
    assert.equal(answer.finish_reason, finishReason === 'stop' ? 'tool-call' : finishReason)
    assert.match(answer.tool_calls[0]!.toolCallId, /^[0-9a-f-]{36}:ollama-1$/u)
    assert.equal(answer.tool_calls[0]!.toolName, 'lookup_marker')
    assert.deepEqual(answer.tool_calls[0]!.arguments, { key: 'test' })
    assert.deepEqual(answer.usage, { input_tokens: 3, output_tokens: 2 })
  }
})

test('owner-scoped Ollama context advertises and pins physical capacity without allowing silent overflow', async () => {
  let chatCount = 0
  let rejectOverflow = false
  const backend = createDeepTestLocalBackend('ollama', createOllamaBackend('http://127.0.0.1:11434', {
    requireUntruncatedContext: true,
    fetchImpl: async (url, init) => {
      const json = (value: unknown) => new Response(JSON.stringify(value))
      if (url.endsWith('/api/version')) return json({ version: '0.40.0' })
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.8:27b', digest: 'a'.repeat(64), size: 100 }] })
      if (url.endsWith('/api/show')) return json({ capabilities: ['completion', 'tools'], details: { family: 'qwen35' },
        model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } })
      assert.ok(url.endsWith('/api/chat'))
      chatCount += 1
      const body = JSON.parse(String(init?.body)) as { options: { num_ctx: number }; truncate: boolean; shift: boolean }
      assert.equal(body.options.num_ctx, 32768)
      assert.equal(body.truncate, false)
      assert.equal(body.shift, false)
      if (rejectOverflow) return new Response('{"error":"input exceeds available context"}', { status: 400 })
      return json({ done: true, done_reason: 'stop', message: { content: 'Complete' } })
    },
  }), { ollamaContextLength: 32768 })
  assert.equal((await backend.models())[0]?.context_length, 32768)
  assert.equal((await backend.chat(chat(), new AbortController().signal)).content, 'Complete')
  await assert.rejects(backend.chat(chat({ context_length: 32769 }), new AbortController().signal),
    /UNSUPPORTED_CAPABILITY/u)
  assert.equal(chatCount, 1, 'a caller cannot raise the owner grant allocation')
  rejectOverflow = true
  await assert.rejects(backend.chat(chat(), new AbortController().signal), /ollama_unreachable/u)
  assert.equal(chatCount, 2, 'physical overflow never produces a successful partial result')
  const smallerModel = createDeepTestLocalBackend('ollama', {
    observe: async () => [{ name: 'small', manifestDigest: 'a'.repeat(64), capabilities: ['completion'],
      numCtxCap: 8192, remoteHost: null, remoteModel: null, sizeBytes: null }],
    stream: async function* () { throw new Error('must not run') },
  }, { ollamaContextLength: 32768 })
  assert.equal((await smallerModel.models())[0]?.context_length, 8192)
})

test('separate Ollama tool chunks retain both proposals with unique response-scoped IDs', async () => {
  const backend = createDeepTestLocalBackend('ollama', {
    observe: async () => [{ name: 'qwen3.8:27b', manifestDigest: 'a'.repeat(64),
      capabilities: ['completion', 'tools'], numCtxCap: 262144, remoteHost: null, remoteModel: null, sizeBytes: null }],
    stream: (input) => streamOllamaChat({ ...input, fetchImpl: async () => new Response([
      { done: false, message: { tool_calls: [{ function: { name: 'lookup_marker', arguments: { key: 'first' } } }] } },
      { done: false, message: { tool_calls: [{ function: { name: 'lookup_marker', arguments: { key: 'second' } } }] } },
      { done: true, done_reason: 'stop', message: { content: '', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 },
    ].map((row) => JSON.stringify(row)).join('\n')) }),
  })
  const request = chat({ tools: [{ toolName: 'lookup_marker', description: 'Synthetic lookup', inputSchema: {} }] })
  const answer = await backend.chat(request, new AbortController().signal)
  assert.equal(answer.finish_reason, 'tool-call')
  assert.equal(answer.tool_calls.length, 2)
  assert.match(answer.tool_calls[0]!.toolCallId, /^[0-9a-f-]{36}:ollama-1$/u)
  const prefix = answer.tool_calls[0]!.toolCallId.slice(0, -1)
  assert.deepEqual(answer.tool_calls.map((call) => ({ ...call, toolCallId: call.toolCallId.replace(prefix, '') })), [
    { toolCallId: '1', toolName: 'lookup_marker', arguments: { key: 'first' } },
    { toolCallId: '2', toolName: 'lookup_marker', arguments: { key: 'second' } },
  ])
  const next = await backend.chat(request, new AbortController().signal)
  assert.notEqual(next.tool_calls[0]!.toolCallId, answer.tool_calls[0]!.toolCallId)
})

test('changed or remote models fail closed, without switching engines', async () => {
  let reads = 0
  let generations = 0
  const backend = createDeepTestLocalBackend('ollama', {
    observe: async () => [{ name: 'qwen3.8:27b', manifestDigest: ++reads > 1 ? 'b'.repeat(64) : 'a'.repeat(64),
      capabilities: ['completion'], numCtxCap: 262144, remoteHost: null, remoteModel: null, sizeBytes: null }],
    stream: async function* () { generations += 1; yield { done: true, text: 'partial', finishReason: 'stop' } },
  })
  await assert.rejects(backend.chat(chat(), new AbortController().signal), /MODEL_CHANGED/u)
  assert.equal(generations, 1)
  const remote = createDeepTestLocalBackend('ollama', { observe: async () => [{ name: 'qwen3.8:27b', manifestDigest: 'a'.repeat(64),
    capabilities: ['completion'], numCtxCap: 262144, remoteHost: 'cloud.example', remoteModel: 'remote', sizeBytes: null }],
  stream: async function* () { throw new Error('must not generate') } })
  assert.deepEqual(await remote.models(), [])
  await assert.rejects(remote.chat(chat(), new AbortController().signal), /MODEL_CHANGED/u)
  const longModel = createDeepTestLocalBackend('openai', {
    observe: async () => [{ name: '界'.repeat(200), manifestDigest: 'a'.repeat(64), capabilities: ['completion'],
      numCtxCap: 8192, remoteHost: null, remoteModel: null, sizeBytes: null }],
    stream: async function* () { throw new Error('uncallable names cannot be advertised') },
  })
  assert.deepEqual(await longModel.models(), [])
  assert.equal(chat({ model_id: `openai:${'a'.repeat(512)}` }).model_id.length, 519)
  assert.throws(() => chat({ model_id: `openai:${'a'.repeat(513)}` }), /REQUEST_INVALID/u)
})

test('owner grants are independent, configuration-pinned and removed when a pairing is forgotten', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-inference-grant-'))
  try {
    await saveExecutorState(directory, { apiBaseUrl: 'https://api.nessie.example', executorId: grant.executorId,
      machinePrivateKey: 'private', machinePublicKey: 'public', workspaceFolders: [{ name: 'fixture', path: directory }],
      descriptor: { operationKeys: [], profiles: [], revision: 1,
        limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65536, maxSessions: 1 } } })
    const path = await publishDeepTestInferenceGrant(directory, ['ollama'], true)
    assert.equal(path, join(directory, DEEPTEST_INFERENCE_GRANT_FILE))
    assert.deepEqual(await loadDeepTestInferenceGrant(path), grant)
    assert.doesNotMatch(await readFile(path, 'utf8'), /private|machinePublic|apiBaseUrl|workspace/u)
    await assert.rejects(publishDeepTestInferenceGrant(directory, ['ollama'], false))
    await assert.rejects(publishDeepTestInferenceGrant(directory, ['openai'], true))
    await publishDeepTestInferenceGrant(directory, ['ollama'], true, { ollamaContextLength: 32768 })
    assert.deepEqual(await loadDeepTestInferenceGrant(path), { ...grant, ollamaContextLength: 32768 })
    for (const value of [0, -1, 1.5, 1_000_001, '32768', null]) {
      assert.throws(() => parseDeepTestInferenceGrant({ ...grant, ollamaContextLength: value }))
    }
    assert.throws(() => parseDeepTestInferenceGrant({ ...grant, engines: ['codex'],
      codingConfigDigest: 'a'.repeat(64), ollamaContextLength: 32768 }))
    const endpoint = { baseUrl: 'http://127.0.0.1:8080/v1', localServiceConfirmed: true as const,
      models: [{ id: 'local', revision: 'one', contextLength: 8192, maxOutputTokens: 2048, tools: true, thinking: false }] }
    await saveLocalOpenAiConfig(directory, endpoint)
    await publishDeepTestInferenceGrant(directory, ['openai'], true)
    const configured = await loadDeepTestInferenceGrant(path)
    await saveLocalOpenAiConfig(directory, { ...endpoint, baseUrl: 'http://127.0.0.1:8081/v1' })
    await assert.rejects(currentInferenceConfig(directory, configured))
    await revokeDeepTestInferenceGrant(directory)
    await assert.rejects(loadDeepTestInferenceGrant(path))
    await publishDeepTestInferenceGrant(directory, ['ollama'], true)
    if (process.platform !== 'win32') {
      await chmod(path, 0o644)
      await assert.rejects(loadDeepTestInferenceGrant(path), /other users/u)
      await chmod(path, 0o600)
    }
    await unlink(join(directory, 'executor-state.json'))
    await assert.rejects(currentInferenceConfig(directory, grant), 'an orphan grant cannot outlive its pairing')
    await clearExecutorState(directory)
    await assert.rejects(loadDeepTestInferenceGrant(path))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('coding engines expose only typed application proposals and fixed ephemeral restrictions', () => {
  const request = chat({ tools: [{ toolName: 'read', description: 'Read approved source', inputSchema: {} }] })
  const parsed = codingInferenceResult(request, '{"content":null,"tool_calls":[{"toolName":"read","arguments":{"path":"app.ts"}}]}')
  assert.equal(parsed.finish_reason, 'tool-call')
  assert.equal(parsed.tool_calls[0]?.toolName, 'read')
  assert.throws(() => codingInferenceResult(request, '{"content":null,"tool_calls":[{"toolName":"Bash","arguments":{}}]}'), /INFERENCE_INCOMPLETE/u)
  assert.throws(() => codingInferenceResult(request, '{"content":"x","tool_calls":[],"command":"sh"}'), /INFERENCE_INCOMPLETE/u)
  assert.match(codingInferencePrompt(request), /Do not inspect files/u)
  for (const engine of ['claude', 'codex'] as const) {
    const args = codingInferenceArguments(engine, '/private/empty', 'selected-model')
    assert.ok(args.includes(engine === 'claude' ? '--no-session-persistence' : '--ephemeral'))
    assert.ok(args.includes(engine === 'claude' ? '--tools' : 'features.shell_tool=false'))
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
    assert.equal(args.includes('--fallback-model'), false)
  }
  assert.throws(() => parseDeepTestInferenceGrant({ ...grant, apiKey: 'secret' }))
  assert.equal(parseCommand(['deeptest-inference', '--inference-grant-file', '/state/deeptest-inference-grant.json']).kind, 'deeptest-inference')
  assert.throws(() => parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'ollama']))
  assert.equal(parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'ollama', '--confirm-inference']).kind,
    'publish-deeptest-inference-grant')
  assert.deepEqual(parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'ollama',
    '--ollama-context-length', '32768', '--confirm-inference']), {
    kind: 'publish-deeptest-inference-grant', stateDir: '/state', engines: ['ollama'], ollamaContextLength: 32768,
  })
  for (const value of ['0', '-1', '1.5', '1e4', '1000001', 'NaN']) {
    assert.throws(() => parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'ollama',
      '--ollama-context-length', value, '--confirm-inference']))
  }
  assert.throws(() => parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'claude',
    '--ollama-context-length', '32768', '--confirm-inference']))
  assert.throws(() => parseCommand(['publish-deeptest-inference-grant', '--state-dir', '/state', '--engines', 'ollama',
    '--ollama-context-length', '32768', '--ollama-context-length', '65536', '--confirm-inference']))
})

test('Claude isolates all writable content state without duplicating its native credential authority', () => {
  const original = { CLAUDE_CONFIG_DIR: '/existing/account', CLAUDE_CODE_DEBUG_LOGS_DIR: '/durable/debug',
    CLAUDE_CODE_DIAGNOSTICS_FILE: '/durable/diagnostics', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }
  const env = codingInferenceEnvironment('claude', original, '/private/ephemeral')
  assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '/existing/account')
  assert.equal(env.CLAUDE_CONFIG_DIR, join('/private/ephemeral', 'claude'))
  assert.equal(env.CLAUDE_CODE_DEBUG_LOGS_DIR, join('/private/ephemeral', 'claude-debug.log'))
  assert.equal(env.CLAUDE_CODE_DIAGNOSTICS_FILE, undefined)
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, undefined)
  assert.equal(codingInferenceEnvironment('claude', {}, '/private/ephemeral').CLAUDE_SECURESTORAGE_CONFIG_DIR, '')
  assert.equal(original.CLAUDE_CODE_DEBUG_LOGS_DIR, '/durable/debug')
})

test('both coding engines use a disposable empty cwd and preserve structured tools through a hermetic native child', { skip: WINDOWS_STATE_HELPER_SKIP }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-inference-cli-'))
  try {
    await ensureOwnerOnlyStateDirectory(directory)
    const target = join(directory, 'target.ts')
    await writeFile(target, 'assessed source stays unchanged')
    const configInput = { codingSessions: { roots: [{ name: 'target', path: directory }],
      agents: { codex: { command: [process.execPath], model: 'fixture' }, claude: { command: [process.execPath], model: 'fixture' } },
      agentEnv: { inheritUserSession: false } } }
    await writeFile(join(directory, 'coding-sessions.json'), JSON.stringify(configInput), { mode: 0o600 })
    const configuredGrant: DeepTestInferenceGrant = { ...grant, engines: ['codex', 'claude'],
      codingConfigDigest: inferenceConfigDigest(normalizeCodingSessionsConfig(configInput)) }
    for (const engine of ['codex', 'claude'] as const) {
      let invoked: { folder: string; args: string[] } | undefined
      const output = JSON.stringify({ content: null, tool_calls: [{ toolName: 'read', arguments: { path: 'app.ts' } }] })
      const events = engine === 'codex'
        ? [{ type: 'item.completed', item: { type: 'agent_message', text: output } },
          { type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }]
        : [{ type: 'result', subtype: 'success', result: output, is_error: false, usage: { input_tokens: 7, output_tokens: 3 } }]
      const fixture = `let input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => { for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event)+'\\n') })`
      const control = createCodingProcessControl(process.platform, { packaged: false })
      const backends = await createDeepTestCodingBackends(directory, configuredGrant, {
        run: async (_file, args) => ({ code: 0, missing: false, stdout: args.includes('--help')
          ? '--strict-config --ephemeral --ignore-user-config --ignore-rules --sandbox --json --tools --strict-mcp-config --safe-mode --restricted --no-session-persistence --permission-prompts'
          : args.includes('--version') ? 'fixture 1' : '{"loggedIn":true}' }),
        control: { ...control, spawnAgent: (_program, args, options) => {
          invoked = { folder: options.cwd, args }
          assert.notEqual(options.cwd, directory)
          assert.equal(args.some((argument) => argument.includes(directory)), false)
          if (engine === 'claude') {
            assert.equal(options.env.CLAUDE_CONFIG_DIR, join(options.cwd, 'claude'))
            assert.equal(options.env.CLAUDE_CODE_DEBUG_LOGS_DIR, join(options.cwd, 'claude-debug.log'))
          }
          return spawn(process.execPath, ['-e', fixture], { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        } },
      })
      const model = (await backends[engine]!.models())[0]!
      const answer = await backends[engine]!.chat(chat({ model_id: model.id, model_digest: model.model_digest,
        tools: [{ toolName: 'read', description: 'Read approved source', inputSchema: {} }] }), new AbortController().signal)
      assert.equal(answer.tool_calls[0]?.toolName, 'read')
      assert.deepEqual(answer.usage, { input_tokens: 7, output_tokens: 3 })
      assert.equal(await readFile(target, 'utf8'), 'assessed source stays unchanged')
      assert.ok(invoked)
      await assert.rejects(stat(invoked.folder), /ENOENT/u)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
