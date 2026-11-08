import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { LocalInferenceAttemptRequest } from '@nessie/executor-protocol'

import { createCodingProcessControl } from '../src/coding-session/process-control.js'
import { createLocalCliEngineBackend, type LocalCliEngineTarget } from '../src/local-cli-engine-backend.js'
import type { LocalCliDetection } from '../src/local-cli-engine-detect.js'
import { LocalCliEngineError } from '../src/local-cli-engine-error.js'
import { CLI_TOOL_BLOCK_CLOSE, CLI_TOOL_BLOCK_OPEN, createCliReplySplitter, parseCliToolBlock } from '../src/local-cli-engine-prompt.js'
import { runLocalInferenceGeneration } from '../src/local-inference-generation.js'
import { capabilityFor } from '../src/local-inference-host-model.js'

const HELP = '--tools --strict-mcp-config --safe-mode --restricted --no-session-persistence --permission-prompts '
  + '--include-partial-messages --effort --strict-config --ephemeral --ignore-user-config --ignore-rules --sandbox --json'

const detection = (signedIn = true): LocalCliDetection => ({
  engine: 'claude-code', profileId: null, installed: true, signedIn,
  ...(signedIn ? { account: 'person@example.com' } : {}),
  program: { path: process.execPath, version: 'fixture 1' }, env: process.env,
})

const fakeRun = (signedIn = true) => async (_file: string, args: string[]) => ({
  code: 0, missing: false,
  stdout: args.includes('--help') ? HELP : args.includes('--version') ? 'fixture 1'
    : JSON.stringify({ loggedIn: signedIn, ...(signedIn ? { email: 'person@example.com' } : {}) }),
})

/** A stand-in `claude -p --output-format stream-json`: each step is [delay ms, JSON line]. */
const claudeFixture = (steps: Array<[number, unknown]>, hang = false): string => `
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', async () => {
  for (const [wait, line] of ${JSON.stringify(steps)}) {
    await new Promise((resolve) => setTimeout(resolve, wait))
    process.stdout.write(JSON.stringify(line) + '\\n')
  }
  if (${hang}) setInterval(() => undefined, 1000)
})`

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta',
  delta: { type: 'text_delta', text } } })

const setUp = (fixture: string, signedIn = true) => {
  const spawned: ChildProcess[] = []
  const control = createCodingProcessControl(process.platform, { packaged: false })
  const target: LocalCliEngineTarget = { engine: 'claude-code', profileId: null, name: null,
    detect: async () => detection(signedIn) }
  const backend = createLocalCliEngineBackend(target, { run: fakeRun(signedIn), control: () => ({ ...control,
    spawnAgent: (_program, args, options) => {
      assert.ok(args.includes('--include-partial-messages'))
      assert.ok(args.includes('--tools') && args.includes('--no-session-persistence'))
      const child = spawn(process.execPath, ['-e', fixture], { ...options, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true })
      spawned.push(child)
      return child
    } }) })
  return { backend, spawned }
}

const attemptFor = async (backend: ReturnType<typeof setUp>['backend'],
  extra: Partial<LocalInferenceAttemptRequest> = {}): Promise<LocalInferenceAttemptRequest> => {
  const [model] = await backend.observe()
  assert.ok(model)
  return {
    attemptId: randomUUID(), bindingId: randomUUID(), bindingRevision: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), hostEpoch: 1, hostId: randomUUID(),
    invocationId: 'invocation', messages: [{ role: 'user', content: 'Read a for me, please.' }],
    modelDigest: model.manifestDigest, modelName: model.name, numCtx: 8192, protocolVersion: 1,
    runId: randomUUID(), runFence: 'fence',
    tools: [{ toolName: 'read', description: 'Read a file', inputSchema: { type: 'object' } }], ...extra,
  }
}

test('the reply splitter holds back only what could start the tool block', () => {
  const splitter = createCliReplySplitter()
  assert.equal(splitter.push('Hello there. <nessie'), 'Hello there. ')
  assert.equal(splitter.push('_tool_calls>\n[]'), '')
  assert.equal(splitter.push(`\n${CLI_TOOL_BLOCK_CLOSE}`), '')
  assert.equal(splitter.tail(), '')
  assert.deepEqual(splitter.finish(), { reply: 'Hello there. ', block: `\n[]\n${CLI_TOOL_BLOCK_CLOSE}` })
  const plain = createCliReplySplitter()
  assert.equal(plain.push('A < b, and <ne'), 'A < b, and ')
  assert.equal(plain.push('ver mind'), '<never mind')
  assert.equal(plain.tail(), '')
})

test('a tool block names only supplied tools with object arguments', () => {
  const attempt = { attemptId: 'a1', tools: [{ toolName: 'read', description: '', inputSchema: {} }] }
  assert.deepEqual(parseCliToolBlock(`[{"toolName":"read","arguments":{"path":"a"}}]\n${CLI_TOOL_BLOCK_CLOSE}`, attempt),
    [{ toolCallId: 'a1:cli-1', toolName: 'read', arguments: { path: 'a' } }])
  for (const block of [`[{"toolName":"Bash","arguments":{}}]\n${CLI_TOOL_BLOCK_CLOSE}`,
    `[{"toolName":"read","arguments":[]}]\n${CLI_TOOL_BLOCK_CLOSE}`, '[{"toolName":"read","arguments":{}}]',
    `[]\n${CLI_TOOL_BLOCK_CLOSE} trailing`]) {
    assert.throws(() => parseCliToolBlock(block, attempt), (error: unknown) =>
      error instanceof LocalCliEngineError && error.code === 'inference_incomplete')
  }
})

test('a turn streams the reply as the CLI writes it and returns its tool calls', async () => {
  const block = `${CLI_TOOL_BLOCK_OPEN}\n[{"toolName":"read","arguments":{"path":"a"}}]\n${CLI_TOOL_BLOCK_CLOSE}`
  const reply = 'Reading it now.\n'
  const { backend, spawned } = setUp(claudeFixture([
    [0, delta('Reading it ')], [400, delta(`now.\n${block.slice(0, 9)}`)], [0, delta(block.slice(9))],
    [0, { type: 'result', subtype: 'success', result: reply + block, is_error: false,
      usage: { input_tokens: 11, output_tokens: 7 } }],
  ]))
  const attempt = await attemptFor(backend)
  const model = (await backend.observe())[0]!
  assert.equal(model.cliEngine, 'claude-code')
  assert.equal(model.cliEngineState, 'ready')
  assert.equal(model.displayName, 'Claude Code')
  const frames: Array<{ text: string; at: number }> = []
  const result = await runLocalInferenceGeneration({
    attempt, capability: () => capabilityFor(attempt, model, new Date()), origin: 'local-cli:claude-code',
    signal: new AbortController().signal, think: false, stream: backend.stream, coalesceMs: 1,
    publish: (_type, text) => { if (text) frames.push({ text, at: Date.now() }) },
    terminal: async () => undefined,
  })
  assert.equal(result.content, reply)
  assert.equal(result.finishReason, 'tool-call')
  assert.deepEqual(result.toolCalls, [{ toolCallId: `${attempt.attemptId}:cli-1`, toolName: 'read', arguments: { path: 'a' } }])
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 })
  assert.equal(result.capability.provider, 'executor/claude-code')
  assert.ok(frames.length >= 2, 'the reply arrived in more than one piece')
  assert.ok(frames[frames.length - 1]!.at - frames[0]!.at >= 300, 'the first words came before the CLI finished')
  assert.equal(frames.map((frame) => frame.text).join(''), reply)
  assert.equal(frames.some((frame) => frame.text.includes('nessie_tool')), false)
  assert.equal(spawned.length, 1)
})

test('cancelling a turn stops the CLI and reports cancelled', async () => {
  const { backend, spawned } = setUp(claudeFixture([[0, delta('Thinking about it')]], true))
  const attempt = await attemptFor(backend)
  const controller = new AbortController()
  const stream = backend.stream({ attempt, origin: 'local-cli:claude-code', signal: controller.signal, think: false })
  const first = await stream.next()
  assert.equal(first.done, false)
  const closed = new Promise((resolve) => spawned[0]!.once('close', resolve))
  controller.abort('cancelled')
  await assert.rejects(stream.next(), (error: unknown) => error instanceof LocalCliEngineError && error.code === 'cancelled')
  await closed
  assert.notEqual(spawned[0]!.exitCode === 0 && spawned[0]!.signalCode === null, true)
})

test('the owner stopping a run ends its turn as session_stopped', async () => {
  const { backend } = setUp(claudeFixture([[0, delta('Working')]], true))
  const attempt = await attemptFor(backend, { sessionId: randomUUID() })
  const stream = backend.stream({ attempt, origin: 'local-cli:claude-code', signal: new AbortController().signal,
    think: false })
  await stream.next()
  backend.stopRuns([attempt.runId])
  await assert.rejects(stream.next(), (error: unknown) =>
    error instanceof LocalCliEngineError && error.code === 'session_stopped')
})

test('a signed-out CLI is advertised as signed out and refuses a turn before starting it', async () => {
  const { backend, spawned } = setUp(claudeFixture([]), false)
  const [model] = await backend.observe()
  assert.equal(model?.cliEngineState, 'signed_out')
  const attempt = await attemptFor(backend)
  await assert.rejects(backend.stream({ attempt, origin: 'x', signal: new AbortController().signal, think: false }).next(),
    (error: unknown) => error instanceof LocalCliEngineError && error.code === 'cli_signed_out')
  assert.equal(spawned.length, 0)
})

test('an output cap or a stopped session is refused, not dropped', async () => {
  const sessionId = randomUUID()
  const { backend, spawned } = setUp(claudeFixture([]))
  const stopped = createLocalCliEngineBackend({ engine: 'claude-code', profileId: null, name: null,
    detect: async () => detection() }, { run: fakeRun(), sessions: { refused: (id) => id === sessionId } })
  for (const [engine, extra, code] of [
    [backend, { maxOutputTokens: 100 }, 'unsupported_capability'],
    [stopped, { sessionId }, 'session_stopped'],
  ] as const) {
    const attempt = await attemptFor(engine, extra)
    await assert.rejects(engine.stream({ attempt, origin: 'x', signal: new AbortController().signal, think: false }).next(),
      (error: unknown) => error instanceof LocalCliEngineError && error.code === code)
  }
  assert.equal(spawned.length, 0)
})

test('an added account is its own model, named by the owner, never by its email', async () => {
  const profileId = randomUUID()
  const backend = createLocalCliEngineBackend({ engine: 'codex', profileId, name: 'Work',
    detect: async () => ({ ...detection(), engine: 'codex', profileId }) }, { run: fakeRun() })
  const [model] = await backend.observe()
  assert.equal(model?.name, `cli:codex:${profileId}`)
  assert.equal(model?.displayName, 'Codex · Work')
  assert.equal(JSON.stringify(model).includes('person@example.com'), false)
})

test('Codex: a notice item is not a tool, a tool item ends the turn incomplete', async () => {
  const codexTurn = async (items: unknown[]) => {
    const control = createCodingProcessControl(process.platform, { packaged: false })
    const events = [{ type: 'thread.started' }, ...items.map((item) => ({ type: 'item.completed', item })),
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } }]
    const backend = createLocalCliEngineBackend({ engine: 'codex', profileId: null, name: null,
      detect: async () => ({ ...detection(), engine: 'codex' }) }, { run: fakeRun(), control: () => ({ ...control,
      spawnAgent: (_program, args, options) => {
        assert.ok(args.includes('--ephemeral') && args.includes('features.shell_tool=false'))
        return spawn(process.execPath, ['-e', claudeFixture(events.map((event) => [0, event]))],
          { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } }) })
    const attempt = await attemptFor(backend as ReturnType<typeof setUp>['backend'], { tools: [] })
    const texts: string[] = []
    for await (const event of backend.stream({ attempt, origin: 'x', signal: new AbortController().signal, think: false })) {
      if (event.text) texts.push(event.text)
    }
    return texts.join('')
  }
  assert.equal(await codexTurn([{ type: 'error', message: 'Under-development features enabled' },
    { type: 'agent_message', text: 'ready' }]), 'ready')
  await assert.rejects(codexTurn([{ type: 'command_execution', command: 'ls', status: 'completed' },
    { type: 'agent_message', text: 'done' }]), (error: unknown) =>
    error instanceof LocalCliEngineError && error.code === 'inference_incomplete')
})
