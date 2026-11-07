import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  canonicalExecutorPayload, ExecutorDaemonSocketConnectSchema, type ExecutorDaemonWakeTopic,
} from '@nessie/executor-protocol'

import { createDaemonCadence, type CadenceTask } from '../src/daemon-cadence.js'
import { ExecutorDaemonDoorbell, doorbellRetryDelayMs, doorbellUrl, type DoorbellSocketLike } from '../src/daemon-doorbell.js'
import { watchSessionChanges } from '../src/session-change-watch.js'

const delay = (ms: number): Promise<void> => new Promise((settle) => { setTimeout(settle, ms) })

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, machinePrivateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url') }
}

/** A server-to-client text frame: unmasked, one fragment. */
const frame = (text: string): Buffer => {
  const payload = Buffer.from(text)
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.from([0x81, 126, 0, 0])
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

/** The first client-to-server text frame: masked, one fragment, under 64 KiB. */
const firstClientText = (socket: Socket): Promise<string> => new Promise((settle) => {
  let buffered = Buffer.alloc(0)
  const read = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    if (buffered.length < 2) return
    let length = buffered[1]! & 0x7f
    let offset = 2
    if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4 }
    if (buffered.length < offset + 4 + length) return
    const mask = buffered.subarray(offset, offset + 4)
    const masked = buffered.subarray(offset + 4, offset + 4 + length)
    const payload = Buffer.from(masked.map((byte, index) => byte ^ mask[index % 4]!))
    socket.off('data', read)
    settle(payload.toString('utf8'))
  }
  socket.on('data', read)
})

const accept = (request: IncomingMessage, socket: Socket): void => {
  const key = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${key}`, '', ''].join('\r\n'))
}

test('the first message is the poll proof, ready slows the polls, wake names topics', { timeout: 30_000 }, async () => {
  const { publicKey, machinePrivateKey } = keys()
  const executorId = randomUUID()
  const sockets: Socket[] = []
  let verified = false
  const server = createServer((_request, response) => { response.writeHead(404).end() })
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    sockets.push(socket)
    assert.equal(request.url, '/api/executor-daemon/socket')
    accept(request, socket)
    void firstClientText(socket).then((text) => {
      const connect = ExecutorDaemonSocketConnectSchema.parse(JSON.parse(text))
      assert.equal(connect.executorId, executorId)
      assert.equal(connect.connectionEpoch, '7')
      const { connectionEpoch, observedAt } = connect
      const payload = { connectionEpoch, executorId: connect.executorId, observedAt }
      verified = verify(null, Buffer.from(canonicalExecutorPayload('nessie.executor.daemon.poll.v1', payload)),
        publicKey, Buffer.from(connect.signature, 'base64url'))
      socket.write(frame(JSON.stringify({ type: 'ready', pollSeconds: 15 })))
      socket.write(frame('not json'))
      socket.write(frame(JSON.stringify({ type: 'wake', topics: ['commands', 'session_views'], payload: 'never' })))
      socket.write(frame(JSON.stringify({ type: 'wake', topics: ['session_views', 'session_views'] })))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const ready: number[] = []
  const wakes: ExecutorDaemonWakeTopic[][] = []
  let downs = 0
  const doorbell = new ExecutorDaemonDoorbell({
    state: () => ({ apiBaseUrl: `http://127.0.0.1:${address.port}`, executorId, machinePrivateKey, connectionEpoch: '7' }),
    onReady: (seconds) => ready.push(seconds), onWake: (topics) => wakes.push(topics), onDown: () => { downs += 1 },
  })
  try {
    doorbell.start()
    for (let waited = 0; wakes.length < 1 && waited < 10_000; waited += 25) await delay(25)
    assert.equal(verified, true, 'the signature verifies as a poll signature')
    assert.deepEqual(ready, [15])
    assert.equal(doorbell.ready, true)
    // A frame with anything beyond its topics is not a wake; a repeated topic runs once.
    assert.deepEqual(wakes, [['session_views']])
    sockets[0]!.destroy()
    for (let waited = 0; downs === 0 && waited < 10_000; waited += 25) await delay(25)
    assert.equal(downs, 1, 'a dropped socket returns the daemon to its one-second cadence')
    assert.equal(doorbell.ready, false)
  } finally {
    doorbell.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('an older Nessie refuses the upgrade and nothing changes', { timeout: 30_000 }, async () => {
  const { machinePrivateKey } = keys()
  let attempts = 0
  const server = createServer((_request, response) => { response.writeHead(404).end() })
  server.on('upgrade', (_request: IncomingMessage, socket: Socket) => {
    attempts += 1
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  let changed = 0
  const doorbell = new ExecutorDaemonDoorbell({
    state: () => ({ apiBaseUrl: `http://127.0.0.1:${address.port}`, executorId: randomUUID(), machinePrivateKey,
      connectionEpoch: '1' }),
    onReady: () => { changed += 1 }, onWake: () => { changed += 1 }, onDown: () => { changed += 1 },
  })
  try {
    doorbell.start()
    for (let waited = 0; attempts < 1 && waited < 10_000; waited += 25) await delay(25)
    await delay(200)
    assert.equal(attempts, 1, 'the next attempt waits its backoff')
    assert.equal(changed, 0, 'no ready, no wake and no down: the cadence never left one second')
    assert.equal(doorbell.ready, false)
  } finally {
    doorbell.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('reconnects back off with jitter, and further when the server never once said ready', () => {
  const half = () => 0.5
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((failures) => doorbellRetryDelayMs(failures, true, half)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
  assert.equal(doorbellRetryDelayMs(9, true, half), 60_000, 'a doorbell that worked once is retried every minute at most')
  assert.equal(doorbellRetryDelayMs(4, false, half), 8_000)
  assert.equal(doorbellRetryDelayMs(9, false, half), 256_000)
  assert.equal(doorbellRetryDelayMs(10, false, half), 300_000, 'a server that never said ready is tried every five minutes')
  assert.equal(doorbellRetryDelayMs(1, true, () => 0), 800)
  assert.equal(doorbellRetryDelayMs(1, true, () => 0.999_999), 1_200)
  assert.equal(doorbellUrl('https://api.nessie.works'), 'wss://api.nessie.works/api/executor-daemon/socket')
  assert.equal(doorbellUrl('http://127.0.0.1:5454/'), 'ws://127.0.0.1:5454/api/executor-daemon/socket')
})

test('a new connection epoch reconnects at once under the new proof', () => {
  const sent: string[] = []
  const opens: Array<() => void> = []
  let epoch = '1'
  const doorbell = new ExecutorDaemonDoorbell({
    state: () => ({ apiBaseUrl: 'https://api.example.invalid', executorId: randomUUID(),
      machinePrivateKey: keys().machinePrivateKey, connectionEpoch: epoch }),
    onReady: () => undefined, onWake: () => undefined, onDown: () => undefined,
    open: (): DoorbellSocketLike => ({
      close: () => undefined, send: (data) => { sent.push(data) }, listen: (handlers) => { opens.push(handlers.open) },
    }),
  })
  doorbell.start()
  opens[0]!()
  epoch = '2'
  doorbell.restart()
  opens[1]!()
  opens[0]!()
  doorbell.stop()
  assert.deepEqual(sent.map((text) => ExecutorDaemonSocketConnectSchema.parse(JSON.parse(text)).connectionEpoch), ['1', '2'],
    'each socket signs its own connect when it opens, and a replaced socket sends nothing')
})

const fakeTask = () => {
  let running: { promise: Promise<void>; finish: () => void } | null = null
  let runs = 0
  const task: CadenceTask = {
    current: () => running?.promise ?? null,
    run: () => {
      if (running) return running.promise
      runs += 1
      let finish = (): void => undefined
      const promise = new Promise<void>((resolve) => { finish = resolve })
      running = { promise, finish: () => { running = null; finish() } }
      return promise
    },
  }
  return { task, runs: () => runs, finish: () => running?.finish() }
}

test('cadence: one second without a socket, pollSeconds with one, one second again while hot', async () => {
  let now = 0
  let hot = false
  const commands = fakeTask()
  const sessions = fakeTask()
  const heartbeat = fakeTask()
  const cadence = createDaemonCadence({
    commands: commands.task, sessions: sessions.task, heartbeat: heartbeat.task, sessionsHot: () => hot, now: () => now,
  })
  const settle = async () => { commands.finish(); sessions.finish(); heartbeat.finish(); await delay(0) }
  cadence.tick()
  await settle()
  for (now = 250; now <= 1_000; now += 250) { cadence.tick(); await settle() }
  assert.deepEqual([commands.runs(), sessions.runs()], [2, 2], 'once a second each')
  cadence.ready(15)
  for (now = 1_250; now <= 10_000; now += 250) { cadence.tick(); await settle() }
  assert.deepEqual([commands.runs(), sessions.runs()], [2, 2], 'the socket slows both polls')
  hot = true
  for (now = 10_250; now <= 12_000; now += 250) { cadence.tick(); await settle() }
  assert.equal(sessions.runs(), 4, 'someone watching keeps the session exchange at one second')
  assert.equal(commands.runs(), 2)
  hot = false
  cadence.wake(['commands', 'heartbeat'])
  await settle()
  assert.deepEqual([commands.runs(), heartbeat.runs()], [3, 1], 'a wake runs its exchange at once')
  cadence.down()
  now += 1_000
  cadence.tick()
  await settle()
  assert.equal(commands.runs(), 4, 'a closed socket returns to one second')
})

test('cadence: a wake or a change during a running exchange runs it once more, a tick does not', async () => {
  const sessions = fakeTask()
  const other = fakeTask()
  const cadence = createDaemonCadence({
    commands: other.task, sessions: sessions.task, heartbeat: other.task, sessionsHot: () => false, now: () => 0,
  })
  cadence.sessionChanged()
  assert.equal(sessions.runs(), 1)
  cadence.sessionChanged()
  cadence.wake(['session_views'])
  cadence.tick()
  assert.equal(sessions.runs(), 1, 'nothing overlaps')
  sessions.finish()
  await delay(0)
  assert.equal(sessions.runs(), 2, 'the change after the running exchange was signed gets its own exchange')
  sessions.finish()
  await delay(0)
  assert.equal(sessions.runs(), 2, 'and only one')
})

test('the change watcher fires once per burst and never for its first look', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nessie-changes-'))
  const marker = join(dir, 'session-changes.json')
  let changes = 0
  await writeFile(marker, '{"n":0}')
  const watch = watchSessionChanges({
    path: () => marker, onChange: () => { changes += 1 }, intervalMs: 20, debounceMs: 60,
  })
  try {
    await delay(100)
    assert.equal(changes, 0)
    await writeFile(`${marker}.tmp`, '{"n":1}')
    const { rename } = await import('node:fs/promises')
    await rename(`${marker}.tmp`, marker)
    await delay(30)
    await writeFile(`${marker}.tmp`, '{"n":22}')
    await rename(`${marker}.tmp`, marker)
    await delay(300)
    assert.equal(changes, 1, 'two replacements in one burst are one exchange')
  } finally {
    watch.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
