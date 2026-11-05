import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocalInferenceAttemptRequest } from '@nessie/executor-protocol'
import { streamOllamaChat } from '../src/ollama-chat.js'

test('Ollama preserves continuation order, reasoning and available tools on the wire', async () => {
  const instruction = 'Continue the unfinished authorized work, then stop.'
  const id = '00000000-0000-4000-8000-000000000001'
  const attempt: LocalInferenceAttemptRequest = {
    attemptId: id, bindingId: id, bindingRevision: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    hostEpoch: 1, hostId: id, invocationId: 'continuation', modelDigest: 'a'.repeat(64), modelName: 'test:local',
    numCtx: 8192, protocolVersion: 1, runFence: 'test-fence', runId: id,
    messages: [
      { role: 'system', content: 'Initial policy.' },
      { role: 'user', content: 'Measure once.' },
      { role: 'assistant', content: 'I will check.', reasoning: 'A measurement requires the tool.' },
      { role: 'system', content: instruction },
    ],
    tools: [{ toolName: 'disk_probe', description: 'Measure disk size.', inputSchema: { type: 'object' } }],
  }
  let body: Record<string, unknown> | undefined
  let calls = 0
  for await (const event of streamOllamaChat({
    attempt, origin: 'http://127.0.0.1:11434', signal: new AbortController().signal, think: true,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(`${JSON.stringify({
        done: true, done_reason: 'stop', model: 'test:local',
        message: { content: '', tool_calls: [{ function: { name: 'disk_probe', arguments: {} } }] },
      })}\n`)
    },
  })) calls += event.toolCalls?.length ?? 0
  const messages = body?.messages as Array<Record<string, unknown>>
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'system'])
  assert.deepEqual(messages.at(-1), { role: 'system', content: instruction })
  assert.equal(messages[2]?.thinking, 'A measurement requires the tool.')
  assert.ok(Array.isArray(body?.tools) && body.tools.length === 1)
  assert.equal(calls, 1)
})
