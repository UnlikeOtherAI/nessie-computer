import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { setTimeout } from 'node:timers/promises'

// Resolve the runtime's own dependency, which powers its pinned public agents.
const requireRuntime = createRequire(new URL('../../packages/support/package.json', import.meta.url))
const { Agent, request } = requireRuntime('undici')
const framing = process.argv[2]
const transport = process.argv[3]
const body = 'x'.repeat(64 * 1024)
const headers = framing === 'length' || framing === 'short'
  ? `Content-Length: ${body.length + (framing === 'short' ? 1 : 0)}\r\n`
  : framing === 'chunked' ? 'Transfer-Encoding: chunked\r\n' : ''
const payload = framing === 'chunked'
  ? `${body.length.toString(16)}\r\n${body}\r\n`
  : body
const server = createServer((socket) => {
  socket.once('data', () => {
    socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n${headers}\r\n${payload}`)
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const agent = new Agent()
try {
  const url = `http://127.0.0.1:${server.address().port}/`
  const response = transport === 'local'
    ? await (await import('../../src/openai-local-observed.ts')).localOpenAiFetch(url, { signal: AbortSignal.timeout(5000) })
    : await request(url, { dispatcher: agent, signal: AbortSignal.timeout(5000) })
  if (transport === 'runtime') response.body.on('error', () => {})
  const consume = () => transport === 'local' ? response.text() : response.body.text()
  // No data listener or reader before FIN: consuming early would hide the crash.
  await setTimeout(300)
  if (framing === 'short' || framing === 'chunked') {
    await assert.rejects(consume())
  } else {
    assert.equal(await consume(), body)
  }
  console.log('completed', framing, transport)
} finally {
  await agent.close()
  await new Promise((resolve) => server.close(resolve))
}
