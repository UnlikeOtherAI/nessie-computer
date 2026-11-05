import { chmod } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'

import { WorkspacePathError } from '../workspace-paths.js'

const ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000
const ACKNOWLEDGEMENT_MAX_BYTES = 64

/**
 * docs/vsock.md, "Host-Initiated Connections": connect to the device's
 * `uds_path`, send "CONNECT PORT\n", and Firecracker answers
 * "OK <assigned_hostside_port>\n" once the guest has accepted. If nobody is
 * listening in the guest, Firecracker terminates the host connection instead,
 * so a closed socket before the acknowledgement is a refusal, not a race.
 */
export const connectGuestVsockPort = async (udsPath: string, port: number): Promise<Socket> => {
  if (!Number.isInteger(port) || port < 1 || port > 0xffff_ffff) {
    throw new WorkspacePathError('The executor micro-VM vsock port is invalid.')
  }
  const socket = createConnection({ path: udsPath })
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const fail = (message: string): void => reject(new WorkspacePathError(message))
      let received = Buffer.alloc(0)
      const timeout = setTimeout(() => {
        fail('The executor micro-VM did not acknowledge the guest vsock connection.')
      }, ACKNOWLEDGEMENT_TIMEOUT_MS)
      const settle = (action: () => void): void => {
        clearTimeout(timeout)
        socket.off('readable', onReadable)
        socket.off('error', onError)
        socket.off('close', onClose)
        action()
      }
      // The acknowledgement is consumed one byte at a time so that whatever
      // the guest has already written after the newline stays in the stream's
      // own buffer, untouched, for the real reader above. Reading it as a
      // chunk and pushing the remainder back leaves the socket paused.
      const onReadable = (): void => {
        for (;;) {
          const byte = socket.read(1) as Buffer | null
          if (byte === null) return
          if (byte[0] === 0x0a) {
            const line = received.toString('ascii')
            settle(() => (/^OK [0-9]+$/.test(line)
              ? resolvePromise()
              : fail('The executor micro-VM refused the guest vsock connection.')))
            return
          }
          received = Buffer.concat([received, byte])
          if (received.byteLength > ACKNOWLEDGEMENT_MAX_BYTES) {
            settle(() => fail('The executor micro-VM answered the vsock connection with an invalid acknowledgement.'))
            return
          }
        }
      }
      const onError = (): void => settle(() => fail('The executor micro-VM vsock socket is unavailable.'))
      const onClose = (): void => settle(() => fail('The executor micro-VM closed the guest vsock connection.'))
      socket.on('readable', onReadable)
      socket.once('error', onError)
      socket.once('close', onClose)
      socket.once('connect', () => socket.write(`CONNECT ${port}\n`))
    })
  } catch (error) {
    socket.destroy()
    throw error
  }
  return socket
}

export type GuestVsockListener = {
  close: () => Promise<void>
  socketPath: string
}

/**
 * docs/vsock.md, "Guest-Initiated Connections": a guest connection to
 * `<port>` is forwarded to a host Unix socket at `<uds_path>_<port>`, which
 * host software must already be listening on — Firecracker resets the guest's
 * connection otherwise. Both of Nessie's guest channels (control and forced
 * egress) are guest-initiated, exactly as under Virtualization.framework, so
 * this is the listener the whole session hangs from.
 */
export const listenGuestVsockPort = async (
  udsPath: string,
  port: number,
  onConnection: (socket: Socket) => void,
): Promise<GuestVsockListener> => {
  const socketPath = `${udsPath}_${port}`
  const server = createServer({ noDelay: true }, onConnection)
  // A later transport error must not become an unhandled EventEmitter throw.
  server.on('error', () => undefined)
  await new Promise<void>((resolvePromise, reject) => {
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
  // The jail root is already owner-only; this keeps the guest channel private
  // even if the chroot base is ever relaxed.
  await chmod(socketPath, 0o600)
  return {
    close: () => new Promise((resolvePromise) => { server.close(() => resolvePromise()) }),
    socketPath,
  }
}
