import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  canonicalExecutorPayload, ExecutorCodingSessionSummarySchema, ExecutorSessionConversationSchema,
  ExecutorSessionViewExchangeSchema, ExecutorSessionViewRequestSchema,
} from '@nessie/executor-protocol'
import { z } from 'zod'
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
      inventory: async () => ({ inventory: { id: randomUUID(), observedAt: new Date().toISOString(), complete: true },
        nextCursor: null, sessions: [{
        ...request, title: 'Live terminal', agent: 'terminal', root: 'work', status: 'working',
        updatedAt: new Date().toISOString(),
      }] }),
      screen: async (asked) => {
        assert.deepEqual(asked, request)
        reads += 1
        return { ansi: 'real screen contract', cols: 120, rows: 36, kind: 'terminal', capturedAt: new Date().toISOString() }
      },
    }, () => true)
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
    assert.equal(received[0]?.conversationVersion, 1, 'the relay explicitly negotiates conversation actions')
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

test('a watched session keeps the relay hot, and a session change forces a fresh first inventory page', async () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const request = { sessionId: randomUUID(), ownerKey: 'sha256:' + 'a'.repeat(64) }
  let offers: unknown = { requests: [request] }
  const bodies: Array<ReturnType<typeof ExecutorSessionViewExchangeSchema.parse>> = []
  const server = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    bodies.push(ExecutorSessionViewExchangeSchema.parse(JSON.parse(Buffer.concat(chunks).toString())))
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify({ data: offers }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const cursors: (string | undefined)[] = []
    const relay = createSessionViewRelay({
      inventory: async (cursor) => {
        cursors.push(cursor)
        const inventory = { id: randomUUID(), observedAt: new Date().toISOString(), complete: true }
        return { inventory, nextCursor: null,
          sessions: [{ ...request, title: 'Waiting', agent: 'claude', root: 'work', status: 'working',
            updatedAt: new Date().toISOString(),
            pending: { kind: 'approval', count: 1, answerable: true, since: new Date().toISOString() } }] }
      },
      screen: async () => null,
    }, () => true)
    const config = normalizeCodingSessionsConfig({
      codingSessions: { roots: [{ name: 'work', path: process.cwd() }], agents: {} },
    })
    const state = {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, executorId: randomUUID(), connectionEpoch: '1',
      machinePrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      descriptor: { codingSessions: codingSessionsFacts(config, 'sha256:' + 'b'.repeat(64)) },
    }
    assert.equal(relay.hot(), false)
    await relay(state)
    assert.equal(relay.hot(), true, 'a view request keeps the one-second pace')
    assert.equal(bodies[0]?.sessions?.[0]?.pending?.kind, 'approval', 'the list row says what the session waits on')
    offers = { requests: [] }
    await relay(state)
    assert.equal(relay.hot(), false)
    assert.equal(bodies[1]?.sessions, undefined, 'the inventory keeps its 15 s pace')
    relay.forceInventory()
    await relay(state)
    assert.equal(bodies[2]?.sessions?.length, 1, 'a change reports at once')
    assert.deepEqual(cursors, [undefined, undefined], 'from its first page')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
})

test('a Nessie that has not shown it reads requests gets neither pending nor requests', async () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const request = { sessionId: randomUUID(), ownerKey: 'sha256:' + 'a'.repeat(64) }
  const bodies: unknown[] = []
  // An older Nessie: the exchange schema as it was before requests, strict all the way down.
  const OlderSummary = ExecutorCodingSessionSummarySchema.omit({ pending: true }).strict()
  const OlderConversation = ExecutorSessionConversationSchema.omit({ requests: true }).strict()
  const OlderExchange = ExecutorSessionViewExchangeSchema.extend({
    sessions: z.array(OlderSummary).optional(),
    frames: z.array(ExecutorSessionViewRequestSchema.extend({
      screen: z.unknown(), conversation: OlderConversation.nullable().optional(),
    }).strict()),
  }).strict()
  let refused = 0
  const server = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const parsed = OlderExchange.safeParse(JSON.parse(Buffer.concat(chunks).toString()))
    if (!parsed.success) refused += 1
    else bodies.push(parsed.data)
    response.writeHead(parsed.success ? 200 : 400, { 'content-type': 'application/json', connection: 'close' })
    response.end(JSON.stringify(parsed.success ? { data: { requests: [request] } }
      : { error: { code: 'VALIDATION_ERROR', message: 'Unrecognized key' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const now = new Date().toISOString()
    const waiting = { kind: 'approval' as const, count: 1, answerable: false, since: now }
    let understood = false
    const relay = createSessionViewRelay({
      inventory: async () => ({ inventory: { id: randomUUID(), observedAt: now, complete: true }, nextCursor: null,
        sessions: [{ ...request, origin: 'external', title: 'Codex thread', agent: 'codex', root: 'work',
          status: 'working', updatedAt: now, pending: waiting }] }),
      screen: async () => null,
      conversation: async () => ({ messages: [], truncated: false, capturedAt: now, sendMode: null, canInterrupt: false,
        requests: [{ id: 'req-1', kind: 'command', status: 'pending', answerable: true, openedAt: now, title: 'Run ls',
          command: 'ls', decisions: ['accept', 'decline'] }] }),
    }, () => understood)
    const config = normalizeCodingSessionsConfig({
      codingSessions: { roots: [{ name: 'work', path: process.cwd() }], agents: {} },
    })
    const state = {
      apiBaseUrl: `http://127.0.0.1:${address.port}`, executorId: randomUUID(), connectionEpoch: '1',
      machinePrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      descriptor: { codingSessions: codingSessionsFacts(config, 'sha256:' + 'b'.repeat(64)) },
    }
    await relay(state)
    await relay(state)
    assert.equal(refused, 0, 'an older Nessie accepts every exchange while something waits')
    assert.equal(bodies.length, 2)
    understood = true
    relay.forceInventory()
    await assert.rejects(relay(state), /Unrecognized key/u)
    assert.equal(refused, 1, 'the same exchange with the new fields is what an older Nessie refuses')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
})
