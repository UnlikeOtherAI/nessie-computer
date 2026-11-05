import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'

import { verifyLocalInferenceEnvelope, localInferenceSocketSignedBody } from '@nessie/local-inference-host'

import { LocalInferenceApiError } from '../src/local-inference-api.js'
import { startLocalInferenceHostSession } from '../src/local-inference-host-session.js'
import type { LocalInferenceSocketLike } from '../src/local-inference-socket.js'
import type { OllamaFetch } from '../src/ollama-client.js'
import {
  ADMISSION, ATTEMPT_ID, HOST_ID, ORG_ID, RESOURCE_ID, attempt, coordinatorFixture, machineKeys, ollama, receiptJournal,
} from './fixtures/local-inference-host.js'

type Request = { at: number; body: Record<string, unknown>; connectionId: string; kind: string; signed: boolean }

/** An in-memory Nessie: answers the handshake and every request, and can push or drop. */
class FakeNessie {
  sockets: FakeSocket[] = []
  requests: Request[] = []
  frames: Array<Record<string, unknown>> = []
  answer: (kind: string, body: Record<string, unknown>) => unknown = () => ({})
  constructor(private readonly publicKey: string) {}
  open = (): LocalInferenceSocketLike => {
    const socket = new FakeSocket(this)
    this.sockets.push(socket)
    queueMicrotask(() => socket.handlers?.open())
    return socket
  }
  get current(): FakeSocket { return this.sockets.at(-1)! }
  requestsOf(kind: string): Request[] { return this.requests.filter((request) => request.kind === kind) }
  receive(socket: FakeSocket, message: Record<string, unknown>): void {
    if (message.type === 'connect') {
      socket.connectionId = randomUUID()
      socket.push({ type: 'connected', connectionId: socket.connectionId, connectionEpoch: '1',
        serverTime: new Date().toISOString() })
      return
    }
    const body = (message.type === 'frame' ? message.frame : message.body) as Record<string, unknown>
    const signed = verifyLocalInferenceEnvelope({ body: localInferenceSocketSignedBody(socket.connectionId, body),
      envelope: message.envelope, machinePublicKey: this.publicKey }).ok
    if (message.type === 'frame') { this.frames.push(body); return }
    this.requests.push({ at: Date.now(), body, connectionId: socket.connectionId, kind: String(message.kind), signed })
    void Promise.resolve(this.answer(String(message.kind), body)).then((data) => {
      if (socket.readyState === 1) socket.push({ type: 'response', id: message.id, data })
    })
  }
}

class FakeSocket implements LocalInferenceSocketLike {
  readyState = 1
  connectionId = ''
  handlers?: Parameters<LocalInferenceSocketLike['listen']>[0]
  constructor(private readonly server: FakeNessie) {}
  send(data: string): void { this.server.receive(this, JSON.parse(data) as Record<string, unknown>) }
  close(code: number): void { this.drop(code) }
  listen(handlers: Parameters<LocalInferenceSocketLike['listen']>[0]): void { this.handlers = handlers }
  push(message: unknown): void { if (this.readyState === 1) this.handlers?.message(JSON.stringify(message)) }
  drop(code = 1006): void {
    if (this.readyState !== 1) return
    this.readyState = 3
    queueMicrotask(() => this.handlers?.close(code))
  }
}

const until = async (satisfied: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!satisfied() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.ok(satisfied(), 'condition not reached in time')
}

/** `until` with no timer of its own, for a test that holds every timer still; the deadline only bounds a failure. */
const untilUntimed = async (satisfied: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = performance.now() + timeoutMs
  while (!satisfied() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(satisfied(), 'condition not reached without a timer')
}

const IDLE = { admission: null, attempt: null, dispatchFence: null }

const host = async (t: TestContext, fetchImpl: OllamaFetch = ollama([])) => {
  const keys = machineKeys()
  const nessie = new FakeNessie(keys.publicKey)
  nessie.answer = (kind) => kind === 'claim' ? IDLE : { acknowledged: true }
  // Stopped before the coordinator directory is removed (hooks run in order).
  let stop: (() => Promise<void>) | undefined
  t.after(() => stop?.())
  const session = startLocalInferenceHostSession({
    apiBaseUrl: 'https://nessie.test', challenge: async () => 'c'.repeat(43), coordinator: await coordinatorFixture(t),
    fetchImpl, identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal: receiptJournal().journal, open: nessie.open, origin: 'http://127.0.0.1:11434',
    onError: () => undefined,
  })
  stop = session.stop
  // Every claim the host makes, from its first, so a test can tell when the host has gone quiet.
  const claiming = { started: 0, settled: 0 }
  const claimOnce = session.loop.claimOnce.bind(session.loop)
  session.loop.claimOnce = async () => {
    claiming.started += 1
    try { return await claimOnce() } finally { claiming.settled += 1 }
  }
  await session.connected
  // Connecting is itself an announcement: owed receipts and tokens are settled first.
  await until(() => nessie.requestsOf('claim').length === 1)
  return { nessie, session, claiming }
}

test('an attempt_available push starts a claim with every timer held still, signed for this connection', async (t) => {
  const { nessie, claiming } = await host(t)
  // The connection's own claim has settled and its chain has ended, so only the push can start another.
  await until(() => claiming.settled === claiming.started)
  await new Promise((resolve) => setImmediate(resolve))
  // From here no timer fires, so a claim that waited for one — a poll, a debounce, a retry — never comes.
  // What the push does start is its own coordinator's file work, then the request, however busy the machine.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pushedAt = Date.now()
  nessie.current.push({ type: 'attempt_available', hostId: HOST_ID, resourceId: RESOURCE_ID })
  await untilUntimed(() => nessie.requestsOf('claim').length === 2)
  const claim = nessie.requestsOf('claim')[1]!
  t.diagnostic(`push to claim request: ${claim.at - pushedAt} ms`)
  assert.equal(claim.signed, true)
})

test('a sibling host hears about work on the shared resource and does not claim it', async (t) => {
  const { nessie } = await host(t)
  nessie.current.push({ type: 'attempt_available', hostId: randomUUID(), resourceId: RESOURCE_ID })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(nessie.requestsOf('claim').length, 1)
})

test('no timer sends a request: an idle host is silent for ten minutes', async (t) => {
  // Every interval the host could start is under the fake clock from the start.
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { nessie } = await host(t)
  t.mock.timers.tick(10 * 60_000)
  // A timeout-driven loop would show within a real second and a half.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(nessie.requests.length, 1)
})

test('a socket dropped mid-generation reconnects, and the result lands exactly once', async (t) => {
  let finish!: () => void
  const fetchImpl: OllamaFetch = (url, init) => url.endsWith('/api/chat')
    ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, message: { content: 'ok' } })}\n`))
        controller.close()
      }
    } })))
    : ollama([])(url, init)
  const { nessie } = await host(t, fetchImpl)
  let offered = false
  nessie.answer = (kind) => {
    if (kind !== 'claim') return kind === 'accept' ? { state: 'active' } : { acknowledged: true }
    if (offered) return IDLE
    offered = true
    return { admission: ADMISSION, attempt: attempt(), dispatchFence: 1 }
  }
  nessie.current.push({ type: 'attempt_available', hostId: HOST_ID, resourceId: RESOURCE_ID })
  await until(() => typeof finish === 'function')
  const first = nessie.current
  first.drop()
  await until(() => nessie.sockets.length === 2 && nessie.current.connectionId !== '')
  finish()
  await until(() => nessie.requestsOf('result').length === 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const results = nessie.requestsOf('result')
  assert.equal(results.length, 1)
  assert.equal(results[0]!.connectionId, nessie.current.connectionId)
  assert.equal((results[0]!.body as { attemptId: string }).attemptId, ATTEMPT_ID)
})

test('a claim whose answer was lost goes back with the same token after reconnecting', async (t) => {
  const { nessie } = await host(t)
  nessie.answer = (kind) => kind === 'claim' ? new Promise(() => undefined) : { acknowledged: true }
  nessie.current.push({ type: 'attempt_available', hostId: HOST_ID, resourceId: RESOURCE_ID })
  await until(() => nessie.requestsOf('claim').length === 2)
  nessie.answer = (kind) => kind === 'claim' ? IDLE : { acknowledged: true }
  nessie.current.drop()
  await until(() => nessie.requestsOf('claim').length === 3)
  const [, lost, replayed] = nessie.requestsOf('claim')
  assert.equal(replayed!.body.requestId, lost!.body.requestId)
  assert.notEqual(replayed!.connectionId, lost!.connectionId)
})

test('a rate-limited challenge is retried after the longest step, never taken as a refusal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const keys = machineKeys()
  const nessie = new FakeNessie(keys.publicKey)
  nessie.answer = (kind) => kind === 'claim' ? IDLE : { acknowledged: true }
  let challenges = 0
  let refused = false
  // Stop the session before the coordinator directory cleanup registered below.
  let stop: (() => Promise<void>) | undefined
  t.after(() => stop?.())
  const session = startLocalInferenceHostSession({
    apiBaseUrl: 'https://nessie.test',
    challenge: async () => {
      challenges += 1
      if (challenges === 1) throw new LocalInferenceApiError('RATE_LIMITED', 429)
      return 'c'.repeat(43)
    },
    coordinator: await coordinatorFixture(t), fetchImpl: ollama([]),
    identity: { connectionEpoch: '1', hostId: HOST_ID, machinePrivateKey: keys.privateKey, organizationId: ORG_ID },
    isPaused: () => false, journal: receiptJournal().journal, open: nessie.open, origin: 'http://127.0.0.1:11434',
    onError: () => undefined,
  })
  stop = session.stop
  void session.refused.then(() => { refused = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(challenges, 1)
  assert.equal(nessie.sockets.length, 0, 'no socket is opened without a challenge')
  t.mock.timers.tick(20_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(challenges, 1, 'the retry waits the longest step (about thirty seconds), not the first')
  t.mock.timers.tick(20_000)
  await session.connected
  assert.equal(challenges, 2)
  assert.equal(refused, false, 'being told to slow down is not a refusal of the host\'s authority')
})
