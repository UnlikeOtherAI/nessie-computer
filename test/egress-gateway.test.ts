import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { tmpdir } from 'node:os'

import {
  ExecutorEgressPolicyError,
  compileExecutorEgressPolicy,
  assertExecutorEgressOrigin,
} from '../src/egress-policy.js'
import { startExecutorEgressGateway } from '../src/egress-gateway.js'

test('browser egress policy permits only distinct canonical HTTPS origins', () => {
  const policy = compileExecutorEgressPolicy({
    allowedOrigins: ['https://example.com', 'https://www.example.com'],
    maxConcurrentTunnels: 2,
  })
  assert.deepEqual([...policy.allowedOrigins].sort(), ['https://example.com', 'https://www.example.com'])
  assert.equal(policy.maxConcurrentTunnels, 2)
  assert.throws(
    () => compileExecutorEgressPolicy({ allowedOrigins: ['http://example.com'] }),
    ExecutorEgressPolicyError,
  )
  assert.throws(
    () => compileExecutorEgressPolicy({ allowedOrigins: ['https://example.com/path'] }),
    ExecutorEgressPolicyError,
  )
  assert.throws(
    () => compileExecutorEgressPolicy({ allowedOrigins: ['https://example.com', 'https://example.com'] }),
    ExecutorEgressPolicyError,
  )
})

test('browser egress target requires an approved origin', () => {
  const policy = compileExecutorEgressPolicy({ allowedOrigins: ['https://example.com'] })
  assert.doesNotThrow(() => assertExecutorEgressOrigin('https://example.com/path', policy))
  assert.throws(
    () => assertExecutorEgressOrigin('https://sub.example.com/path', policy),
    ExecutorEgressPolicyError,
  )
  assert.throws(
    () => assertExecutorEgressOrigin('https://example.com:444/path', policy),
    ExecutorEgressPolicyError,
  )
})

test('the daemon gateway is Unix-only and rejects a blocked CONNECT before it dials', {
  skip: process.platform === 'win32' ? 'The egress gateway is a Unix socket in a directory proved owner-only by mode bits.' : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-executor-egress-'))
  const socketPath = join(directory, 'egress.sock')
  await chmod(directory, 0o700)
  const gateway = await startExecutorEgressGateway({
    policy: { allowedOrigins: ['https://localhost'] },
    socketPath,
  })
  try {
    assert.equal((await lstat(socketPath)).mode & 0o077, 0)
    const response = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(socketPath)
      socket.once('connect', () => socket.end('CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n'))
      socket.once('data', (chunk: Buffer) => resolvePromise(chunk.toString('utf8')))
      socket.once('error', reject)
    })
    assert.match(response, /^HTTP\/1\.1 403 Forbidden\r\n/)
  } finally {
    await gateway.close()
    await rm(directory, { force: true, recursive: true })
  }
})
