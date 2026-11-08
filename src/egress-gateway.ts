import { createServer, type IncomingMessage, type Server } from 'node:http'
import { chmod, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Duplex } from 'node:stream'

import { pinnedConnect } from '@nessie/executor-support/url-safety'

import {
  compileExecutorEgressPolicy,
  assertExecutorEgressOrigin,
  type ExecutorEgressPolicy,
  type ExecutorEgressSettings,
} from './egress-policy.js'

const SOCKET_PATH_MAX_CHARS = 96
const OWNER_ONLY_MASK = 0o077

type CloseableGateway = {
  close: () => Promise<void>
  socketPath: string
}

const socketFailure = (socket: Duplex, status: number, message: string): void => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

const assertOwnerOnlySocketParent = async (rawSocketPath: string): Promise<string> => {
  if (!isAbsolute(rawSocketPath)) {
    throw new Error('The egress socket path must be absolute.')
  }
  const socketPath = resolve(rawSocketPath)
  if (socketPath.length > SOCKET_PATH_MAX_CHARS) {
    throw new Error('The egress socket path is too long.')
  }
  const parent = dirname(socketPath)
  const metadata = await lstat(parent)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The egress socket parent must be an ordinary directory.')
  }
  if (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) {
    throw new Error('The egress socket parent must be owned by the current user.')
  }
  if ((metadata.mode & OWNER_ONLY_MASK) !== 0) {
    throw new Error('The egress socket parent must be owner-only.')
  }
  try {
    await lstat(socketPath)
    throw new Error('The egress socket path already exists.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return socketPath
}

const requestTarget = (request: IncomingMessage): string | null => {
  const rawAuthority = request.url
  if (!rawAuthority || /[\s/?#@]/.test(rawAuthority)) return null
  try {
    const target = new URL(`https://${rawAuthority}`)
    // The browser's encrypted request determines the HTTP path. The gateway
    // accepts only canonical HTTPS, never arbitrary proxy ports or schemes.
    return target.port || target.protocol !== 'https:' ? null : target.toString()
  } catch {
    return null
  }
}

const listen = async (server: Server, socketPath: string): Promise<void> => new Promise((resolvePromise, reject) => {
  const fail = (error: Error): void => {
    server.off('listening', ready)
    reject(error)
  }
  const ready = (): void => {
    server.off('error', fail)
    resolvePromise()
  }
  server.once('error', fail)
  server.once('listening', ready)
  server.listen(socketPath)
})

/**
 * Starts a daemon-private CONNECT gateway. It has no TCP listener, accepts no
 * HTTP request forwarding, and permits HTTPS only through explicit locally
 * approved origins. A later VM broker may bridge its single guest-facing
 * transport to this Unix socket; nothing binds a browser descriptor to it yet.
 */
export const startExecutorEgressGateway = async (input: {
  policy: ExecutorEgressPolicy
  socketPath: string
}): Promise<CloseableGateway> => {
  const settings = compileExecutorEgressPolicy(input.policy)
  const socketPath = await assertOwnerOnlySocketParent(input.socketPath)
  let activeTunnels = 0
  const server = createServer((_request, response) => {
    response.writeHead(405, { connection: 'close', 'content-length': '0' })
    response.end()
  })
  server.on('connect', (request, clientSocket, head) => {
    if (activeTunnels >= settings.maxConcurrentTunnels) {
      socketFailure(clientSocket, 429, 'Too Many Requests')
      return
    }
    const target = requestTarget(request)
    if (!target) {
      socketFailure(clientSocket, 400, 'Bad Request')
      return
    }
    activeTunnels += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeTunnels -= 1
    }
    clientSocket.once('close', release)
    void (async () => {
      try {
        assertExecutorEgressOrigin(target, settings)
        const { socket: upstream } = await pinnedConnect(target)
        upstream.once('close', release)
        upstream.once('error', () => clientSocket.destroy())
        clientSocket.once('error', () => upstream.destroy())
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)
      } catch {
        socketFailure(clientSocket, 403, 'Forbidden')
      }
    })()
  })
  // The listen promise handles startup errors; a later transport error should
  // close the socket rather than become an unhandled EventEmitter exception.
  server.on('error', () => undefined)
  await listen(server, socketPath)
  await chmod(socketPath, 0o600)
  return {
    close: async () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    }),
    socketPath,
  }
}

export type { ExecutorEgressSettings }
