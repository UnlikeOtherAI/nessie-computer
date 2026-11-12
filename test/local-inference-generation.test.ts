import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import type { LocalInferenceStreamFrameType } from '../src/local-inference-frames.js'
import { runLocalInferenceGeneration } from '../src/local-inference-generation.js'
import type { OllamaChatEvent } from '../src/ollama-chat.js'
import { attempt, localResult } from './fixtures/local-inference-host.js'

type Frame = { type: LocalInferenceStreamFrameType; text: string; final: boolean }

const events = async function* (items: OllamaChatEvent[], gapMs = 0): AsyncGenerator<OllamaChatEvent> {
  for (const item of items) {
    if (gapMs) await delay(gapMs)
    yield item
  }
}

const generate = (input: { stream: AsyncGenerator<OllamaChatEvent>; coalesceMs?: number; now?: () => number }) => {
  const frames: Frame[] = []
  let terminated = 0
  const result = runLocalInferenceGeneration({
    attempt: attempt(), capability: () => localResult().capability, coalesceMs: input.coalesceMs ?? 20,
    origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: true,
    stream: () => input.stream,
    publish: (type, text, final) => { frames.push({ type, text, final }) },
    terminal: async () => { terminated += 1 },
    ...(input.now ? { now: input.now } : {}),
  })
  return { result, frames, terminated: () => terminated }
}

test('a token stream travels as a few ordered frames, with its text and reasoning intact', async () => {
  const tokens = Array.from({ length: 40 }, (_, index) => `t${index} `)
  const g = generate({ stream: events([
    ...['I ', 'think ', 'so.'].map((thinking) => ({ done: false, thinking })),
    ...tokens.map((text) => ({ done: false, text })),
    { done: true, finishReason: 'stop' as const, inputTokens: 3, outputTokens: 43 },
  ]) })
  const result = await g.result
  assert.equal(result.reasoning, 'I think so.')
  assert.equal(result.content, tokens.join(''))
  assert.equal(g.terminated(), 1)
  assert.ok(g.frames.length < tokens.length / 4, `expected coalescing, got ${g.frames.length} frames`)
  const kinds = g.frames.map((frame) => frame.type)
  assert.equal(kinds.lastIndexOf('reasoning_text.delta') < kinds.indexOf('output_text.delta'), true)
  assert.equal(g.frames.filter((frame) => frame.type === 'output_text.delta').map((frame) => frame.text).join(''),
    tokens.join(''))
  assert.deepEqual(g.frames.map((frame) => frame.final), [...g.frames.slice(1).map(() => false), true])
  assert.equal(g.frames[0]?.text, 'I ', 'the first words travel at once, never waiting for the window')
})

test('a stream that ends on tool calls still sends one final, empty frame', async () => {
  const g = generate({ stream: events([{ done: true, finishReason: 'tool-call' as const, toolCalls: [] }]) })
  await g.result
  assert.deepEqual(g.frames, [{ type: 'output_text.delta', text: '', final: true }])
})

test('the receipt reports the host-measured generation time', async () => {
  let clock = 1_000
  const g = generate({
    now: () => clock,
    stream: (async function* () {
      yield { done: false, text: 'a' }
      clock += 1_234
      yield { done: true, finishReason: 'stop' as const }
    })(),
  })
  assert.equal((await g.result).generationMs, 1_234)
})

test('a frame that cannot be sent never stops the model or its terminal proof', async () => {
  let terminated = 0
  const result = await runLocalInferenceGeneration({
    attempt: attempt(), capability: () => localResult().capability, coalesceMs: 1,
    origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: false,
    stream: () => events([{ done: false, text: 'a' }, { done: true, finishReason: 'stop' as const }]),
    publish: () => undefined,
    terminal: async () => { terminated += 1 },
  })
  assert.equal(result.content, 'a')
  assert.equal(terminated, 1)
})
