import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import { canonicalExecutorPayload, ExecutorSessionViewExchangeSchema } from '@nessie/executor-protocol'
import { createSessionViewRelay } from '../src/session-view-relay.js'
import { codingSessionsFacts } from '../src/coding-sessions-policy.js'
import { normalizeCodingSessionsConfig } from '../src/coding-session/config.js'

test('terminal relay signs HTTP exchanges, uploads only demanded screens and drops stale demand on failure', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const executorId = randomUUID()
  const request = { sessionId: randomUUID(), ownerKey: 'sha256:' + 'a'.repeat(64) }
  const received: Array<ReturnType<typeof ExecutorSessionViewExchangeSchema.parse>> = []
  let fail = false
  let serverFailure: unknown
  const server = createServer(async (incoming, response) => {
    try {
      assert.equal(incoming.url, '/api/executor-daemon/session-views')
      const chunks = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const body = ExecutorSessionViewExchangeSchema.parse(JSON.parse(Buffer.concat(chunks).toString()))
      const { signature, ...payload } = body
      assert(verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.session_view.v1', payload)),
        publicKey, Buffer.from(signature, 'base64url')))
      received.push(body)
      response.writeHead(fail ? 503 : 200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify(fail
        ? { error: { code: 'TEMPORARY', message: 'Reconnect' } } : { data: { requests: [request] } }))
    } catch (error) {
      serverFailure = error
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    let reads = 0
    const relay = createSessionViewRelay({
      inventory: async () => [{
        ...request, title: 'Live terminal', agent: 'terminal', root: 'work', status: 'working',
        updatedAt: new Date().toISOString(),
      }],
      screen: async (asked) => {
        assert.deepEqual(asked, request)
        reads += 1
        return { ansi: 'real screen contract', cols: 120, rows: 36, kind: 'terminal', capturedAt: new Date().toISOString() }
      },
    })
    const config = normalizeCodingSessionsConfig({
      codingSessions: { roots: [{ name: 'work', path: process.cwd() }], agents: {} },
    })
    const state = {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, executorId, connectionEpoch: '1',
      machinePrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      descriptor: { codingSessions: codingSessionsFacts(config, 'sha256:' + 'b'.repeat(64)) },
    }
    await relay(state)
    assert.equal(reads, 0, 'no viewer demand means no screen is read or uploaded')
    assert.equal(received[0]?.sessions?.length, 1, 'metadata is reported independently of viewers')
    await relay(state)
    assert.equal(received[1]?.frames[0]?.screen?.ansi, 'real screen contract')
    fail = true
    await assert.rejects(relay(state))
    fail = false
    await relay({ ...state, connectionEpoch: '2' })
    assert.equal(received[3]?.frames.length, 0, 'a reconnect obtains fresh demand before uploading')
    assert.equal(received[3]?.connectionEpoch, '2')
    assert.equal(serverFailure, undefined)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Let the HTTP client's socket-close callbacks finish before node:test forces exit.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
})
