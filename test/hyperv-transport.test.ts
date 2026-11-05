import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, stat } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  GUEST_CONTROL_PORT,
  GUEST_EGRESS_PORT,
  deriveGuestEgressToken,
  startGuestControlChannel,
  startGuestEgressBridge,
} from '../src/firecracker/index.js'
import { bridgeArgv, createGuestPipeListener, hyperVLayout, hyperVPipePath } from '../src/hyperv/index.js'
import { encodeGuestFrame } from './firecracker-fake.js'

const VM_ID = '1d2b3c4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const TOKEN = 'a'.repeat(43)

/**
 * A pipe prefix of the kind a session gets: a `\\.\pipe\…` name on Windows,
 * the only thing `net` listens on there, and a socket path in a fresh
 * directory elsewhere.
 */
const prefix = async (): Promise<string> => (process.platform === 'win32'
  ? `\\\\.\\pipe\\nessie-hv-test-${randomUUID()}`
  : join(await mkdtemp(join(tmpdir(), 'nessie-hv-pipe-')), 'pipe'))

/**
 * `net` treats `\\.\pipe\…` as a named pipe on Windows and an ordinary
 * filesystem socket elsewhere, so the transport is path-agnostic by
 * construction and the very code that runs on Windows is exercised here —
 * over real named pipes when the suite runs on Windows.
 */
test('a guest channel listens on <prefix>-<port>, the shape Firecracker uses for its sockets', async () => {
  const root = await prefix()
  const listener = await createGuestPipeListener()(root, GUEST_CONTROL_PORT, () => undefined)
  try {
    assert.equal(listener.socketPath, `${root}-${GUEST_CONTROL_PORT}`)
    assert.equal(listener.socketPath, hyperVPipePath(root, GUEST_CONTROL_PORT))
    // Owner-only where the platform has mode bits at all. A named pipe has no
    // file to stat: it carries the daemon account's own DACL, and the listen
    // above resolving is what proves it exists.
    if (process.platform !== 'win32') {
      const info = await stat(listener.socketPath)
      assert.ok(info.isSocket())
      assert.equal(info.mode & 0o077, 0)
    }
  } finally {
    await listener.close()
  }
  assert.throws(() => hyperVPipePath(root, 0), /channel port is invalid/)
})

test('the control channel authenticates a guest over the pipe transport unchanged', async () => {
  const root = await prefix()
  const channel = await startGuestControlChannel(root, TOKEN, createGuestPipeListener())
  const guest: Socket = createConnection({ path: `${root}-${GUEST_CONTROL_PORT}` })
  try {
    await new Promise<void>((resolvePromise) => guest.once('connect', resolvePromise))
    guest.write(encodeGuestFrame({
      kind: 'hello',
      payload: '',
      requestId: randomUUID(),
      sessionToken: TOKEN,
      version: 1,
    }))
    const ready = await channel.connected
    // The ready line the shared control client waits for, produced by the same
    // authenticated moment on both backends.
    const line: string = await new Promise((resolvePromise) => {
      ready.output.once('data', (chunk: Buffer) => resolvePromise(chunk.toString('utf8')))
    })
    assert.deepEqual(JSON.parse(line.trim()), { session: 'ready', valid: true, workspaceAttached: true })
  } finally {
    guest.destroy()
    await channel.close()
  }
})

test('a guest offering the wrong control token is refused over the pipe transport too', async () => {
  const root = await prefix()
  const channel = await startGuestControlChannel(root, TOKEN, createGuestPipeListener())
  const guest: Socket = createConnection({ path: `${root}-${GUEST_CONTROL_PORT}` })
  try {
    await new Promise<void>((resolvePromise) => guest.once('connect', resolvePromise))
    guest.write(encodeGuestFrame({
      kind: 'hello',
      payload: '',
      requestId: randomUUID(),
      sessionToken: 'b'.repeat(43),
      version: 1,
    }))
    await assert.rejects(channel.connected, /failed its control authentication/)
  } finally {
    guest.destroy()
    await channel.close()
  }
})

test('an egress tunnel presents its prelude and is relayed to the gateway, over pipes', async () => {
  const root = await prefix()
  const gatewayRoot = await prefix()
  const gatewayPath = `${gatewayRoot}-gateway`
  const received: Buffer[] = []
  const gateway = (await import('node:net')).createServer((socket) => {
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk)
      socket.write(Buffer.from('ok'))
    })
  })
  await new Promise<void>((resolvePromise) => { gateway.listen(gatewayPath, resolvePromise) })
  const bridge = await startGuestEgressBridge({
    bootstrapToken: TOKEN,
    gatewaySocketPath: gatewayPath,
    listenPort: createGuestPipeListener(),
    vsockPath: root,
  })
  const guest: Socket = createConnection({ path: `${root}-${GUEST_EGRESS_PORT}` })
  try {
    await new Promise<void>((resolvePromise) => guest.once('connect', resolvePromise))
    const prelude = Buffer.alloc(48)
    prelude.write('NEXG', 0, 'ascii')
    prelude.writeUInt8(1, 4)
    Buffer.from(deriveGuestEgressToken(TOKEN), 'utf8').copy(prelude, 5)
    guest.write(Buffer.concat([prelude, Buffer.from('CONNECT example.com:443\r\n\r\n')]))
    const answer: Buffer = await new Promise((resolvePromise) => {
      guest.once('data', (chunk: Buffer) => resolvePromise(chunk))
    })
    assert.equal(answer.toString('utf8'), 'ok')
    // The bridge relays bytes and never the prelude: the gateway alone decides
    // what a tunnel may reach.
    assert.equal(Buffer.concat(received).toString('utf8'), 'CONNECT example.com:443\r\n\r\n')
  } finally {
    guest.destroy()
    await bridge.close()
    await new Promise<void>((resolvePromise) => { gateway.close(() => resolvePromise()) })
  }
})

test('the bridge is launched per channel with a validated VM id and pipe name', () => {
  const layout = hyperVLayout({ sessionDirectory: '/state/session', sessionId: 'abc123' })
  assert.equal(layout.pipePrefix, '\\\\.\\pipe\\nessie-hv-abc123')
  assert.equal(layout.vmName, 'nessie-executor-abc123')
  assert.deepEqual(bridgeArgv({
    direction: 'guest-to-host',
    pipePrefix: layout.pipePrefix,
    port: GUEST_CONTROL_PORT,
    vmId: VM_ID,
  }), [
    '--vm-id', VM_ID,
    '--port', '49152',
    '--pipe', '\\\\.\\pipe\\nessie-hv-abc123-49152',
    '--direction', 'guest-to-host',
  ])
  assert.throws(
    () => bridgeArgv({ direction: 'guest-to-host', pipePrefix: layout.pipePrefix, port: 1, vmId: 'nope' }),
    /VM identity is invalid/,
  )
  assert.throws(
    () => hyperVLayout({ sessionDirectory: '/state', sessionId: '../escape' }),
    /session id is invalid/,
  )
})
