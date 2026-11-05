import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertFirecrackerHostReady,
  buildFirecrackerArgv,
  connectGuestVsockPort,
  deriveGuestEgressToken,
  firecrackerLayout,
  listenGuestVsockPort,
  KVM_DEVICE_PATH,
} from '../src/firecracker/index.js'
import {
  createVirtualizationFrameworkBackend,
  selectGuestVmBackend,
  stopChildProcess,
} from '../src/guest-vm-backend.js'
import type { ExecutorHost } from '../src/host-platform.js'

/**
 * Firecracker runs only on a Linux host, and these cases stage what it meets
 * there: Unix sockets, POSIX signals and POSIX paths. On Windows a socket
 * path is not a pipe name, and a listen that never succeeds brought Node down
 * at exit. The backend seam, the macOS argv and the token run everywhere.
 */
const LINUX_HOST_ONLY = process.platform === 'win32'
  ? 'Firecracker runs on Linux: its vsock is a Unix socket, it stops with SIGTERM then SIGKILL, and its layout is POSIX paths.'
  : false

const host = (sandboxBackend: ExecutorHost['sandboxBackend'], os: 'linux' | 'macos' | 'windows'): ExecutorHost => ({
  platform: { architecture: os === 'macos' ? 'arm64' : 'x64', os, osMajorVersion: 15 },
  sandboxBackend,
  supervisor: 'service',
})

test('the backend seam picks from the host fact and refuses in words when there is none', () => {
  assert.equal(
    selectGuestVmBackend(host('virtualization_framework', 'macos')).kind,
    'virtualization_framework',
  )
  const firecracker = { kind: 'firecracker' as const, start: async () => { throw new Error('unused') } }
  assert.equal(selectGuestVmBackend(host('firecracker', 'linux'), {}, () => firecracker), firecracker)
  assert.throws(
    () => selectGuestVmBackend(host('none', 'linux')),
    /no sandbox backend/,
  )
  const hyperv = { kind: 'hyperv' as const, start: async () => { throw new Error('unused') } }
  assert.equal(selectGuestVmBackend(host('hyperv', 'windows'), {}, undefined, () => hyperv), hyperv)
  assert.throws(
    () => selectGuestVmBackend(host('hyperv', 'windows')),
    /Hyper-V backend is unavailable/,
  )
  // A firecracker host with no factory available fails closed rather than
  // silently falling through to the macOS helper.
  assert.throws(() => selectGuestVmBackend(host('firecracker', 'linux')), /Firecracker backend is unavailable/)
})

test('the macOS backend still builds exactly the session argv the signed helper expects', async () => {
  const calls: Array<{ argv: string[]; input: string; path: string }> = []
  const backend = createVirtualizationFrameworkBackend({
    launchProcess: async (call) => {
      calls.push(call)
      return {
        actBrowser: async () => ({ status: 'acted' as const }),
        closed: Promise.resolve(),
        closeCodingSession: async () => {},
        inspectRuntime: async () => ({ browser: false, claude: false, codex: false, tmux: false }),
        launchCodingSession: async () => {},
        observeCodingSession: async () => ({ agent: 'codex' as const, lifecycle: 'running' as const }),
        observeBrowser: async () => ({ accessibilityTree: [], targets: [] }),
        openBrowser: async () => {},
        runCommand: async () => ({ exitCode: 0, output: '', success: true }),
        stop: async () => {},
      }
    },
  })
  await backend.start({
    bootstrapToken: 'token',
    consolePath: '/console',
    egressGatewaySocketPath: '/gateway.sock',
    initrdPath: '/initrd',
    kernelPath: '/kernel',
    readyTimeoutMs: 1,
    resources: { memoryMiB: 4_096, vcpuCount: 2 },
    runtimeManifestDigest: `sha256:${'b'.repeat(64)}`,
    runtimeSnapshotPath: '/runtime',
    sessionDirectory: '/session',
    sessionId: 'session',
    vmHelperPath: '/helper',
    workspacePath: '/work',
  })
  assert.deepEqual(calls[0].argv, [
    'session',
    '--console', '/console',
    '--kernel', '/kernel',
    '--initrd', '/initrd',
    '--workspace-cow', '/work',
    '--runtime-bundle', '/runtime',
    '--runtime-manifest-digest', `sha256:${'b'.repeat(64)}`,
    '--egress-gateway', '/gateway.sock',
    '--bootstrap-token-stdin',
  ])
  assert.equal(calls[0].input, 'token')
  assert.equal(calls[0].argv.includes('token'), false)
})

test('Firecracker is run by the daemon itself, with default seccomp and no jailer', { skip: LINUX_HOST_ONLY }, async () => {
  const layout = firecrackerLayout({ sessionId: 'abc-123', socketDirectory: '/tmp/nex-fc-1' })
  assert.equal(layout.apiSocketPath, '/tmp/nex-fc-1/api.sock')
  assert.equal(layout.vsockPath, '/tmp/nex-fc-1/v.sock')
  const argv = buildFirecrackerArgv({ apiSocketPath: layout.apiSocketPath, sessionId: 'abc-123' })
  assert.deepEqual(argv, ['--api-sock', '/tmp/nex-fc-1/api.sock', '--id', 'abc-123'])
  // Firecracker's seccomp filters are on by default (docs/seccomp.md) and the
  // only way to lose them is a flag this backend never builds.
  assert.equal(argv.includes('--no-seccomp'), false)
  assert.equal(argv.includes('--seccomp-filter'), false)
  // Neither the layout nor the argv can be steered by a malformed session id.
  assert.throws(
    () => firecrackerLayout({ sessionId: 'not a valid id', socketDirectory: '/tmp/x' }),
    /session id is invalid/,
  )
  assert.throws(
    () => buildFirecrackerArgv({ apiSocketPath: '/tmp/x/api.sock', sessionId: '../escape' }),
    /session id is invalid/,
  )
  // The host gate is /dev/kvm access, not root: the remedy is a group.
  let requested = ''
  await assertFirecrackerHostReady({
    access: async (path) => { requested = path },
  })
  assert.equal(requested, KVM_DEVICE_PATH)
  await assert.rejects(
    assertFirecrackerHostReady({ access: async () => { throw new Error('EACCES') } }),
    /kvm group/,
  )
})

test('the guest egress token is the HMAC the guest itself derives', () => {
  // Cross-checked against executor/guest/protocol.go deriveEgressToken: the
  // same 32-byte key and the same fixed context string.
  const token = 'A'.repeat(43)
  assert.equal(deriveGuestEgressToken(token).length, 43)
  assert.notEqual(deriveGuestEgressToken(token), token)
  assert.throws(() => deriveGuestEgressToken('short'), /bootstrap token is malformed/)
})

test('a host-initiated vsock connection sends CONNECT and waits for the OK acknowledgement', { skip: LINUX_HOST_ONLY }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-'))
  const udsPath = join(directory, 'v.sock')
  const received: string[] = []
  const server = createServer((socket: Socket) => {
    socket.once('data', (chunk: Buffer) => {
      received.push(chunk.toString('utf8'))
      // Firecracker's acknowledgement, plus a first guest byte in the same
      // write: the client must keep that byte for the real reader.
      socket.write('OK 1073741824\nhello-guest')
    })
  })
  try {
    await new Promise<void>((resolvePromise) => server.listen(udsPath, () => resolvePromise()))
    const socket = await connectGuestVsockPort(udsPath, 49_152)
    assert.deepEqual(received, ['CONNECT 49152\n'])
    const first = await new Promise<Buffer>((resolvePromise) => socket.once('data', resolvePromise))
    assert.equal(first.toString('utf8'), 'hello-guest')
    socket.destroy()
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { force: true, recursive: true })
  }
})

test('a refused host-initiated vsock connection is an error, never a half-open stream', { skip: LINUX_HOST_ONLY }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-refuse-'))
  const udsPath = join(directory, 'v.sock')
  const server = createServer((socket: Socket) => {
    // Firecracker terminates the host connection when nothing is listening.
    socket.once('data', () => socket.destroy())
  })
  try {
    await new Promise<void>((resolvePromise) => server.listen(udsPath, () => resolvePromise()))
    await assert.rejects(connectGuestVsockPort(udsPath, 52), /closed the guest vsock connection/)
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { force: true, recursive: true })
  }
})

test('guest-initiated connections arrive on the per-port socket Firecracker forwards to', { skip: LINUX_HOST_ONLY }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-vsock-listen-'))
  const udsPath = join(directory, 'v.sock')
  let seen: Buffer | undefined
  const listener = await listenGuestVsockPort(udsPath, 49_153, (socket) => {
    socket.once('data', (chunk: Buffer) => { seen = chunk })
  })
  try {
    assert.equal(listener.socketPath, `${udsPath}_49153`)
    const { createConnection } = await import('node:net')
    const guest = createConnection({ path: listener.socketPath })
    await new Promise<void>((resolvePromise) => guest.once('connect', () => resolvePromise()))
    guest.write(randomBytes(4))
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50) })
    assert.equal(seen?.byteLength, 4)
    guest.destroy()
  } finally {
    await listener.close()
    await rm(directory, { force: true, recursive: true })
  }
})

test('a process that ignores SIGTERM is killed once the stop window has passed', { skip: LINUX_HOST_ONLY }, async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')",
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('Signal fixture did not become ready.')), 10_000)
      child.once('message', (message) => {
        clearTimeout(timeout)
        if (message === 'ready') resolvePromise()
        else reject(new Error('Unexpected signal fixture readiness message.'))
      })
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Signal fixture exited before readiness.')) })
    })
    await stopChildProcess(child, 250)
    assert.equal(child.signalCode, 'SIGKILL')
  } finally {
    await stopChildProcess(child, 0)
  }
})
