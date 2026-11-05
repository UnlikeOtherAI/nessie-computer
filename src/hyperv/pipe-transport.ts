import { chmod } from 'node:fs/promises'
import { createServer } from 'node:net'
import { platform } from 'node:process'

import type { GuestChannelListener } from '../firecracker/index.js'
import type { GuestVsockListener } from '../firecracker/vsock.js'
import { hyperVPipePath } from './layout.js'

/**
 * Node has no `AF_HYPERV`, so a guest's connection reaches the daemon through a
 * **Windows named pipe** that `nessie-hyperv-bridge.exe` pumps from the
 * `AF_HYPERV` socket. This is the daemon's half: it listens on that pipe before
 * the VM is started, exactly as the Firecracker backend opens its Unix-socket
 * listeners before `InstanceStart`, and hands each accepted connection to the
 * shared control and egress code unchanged.
 *
 * The name is `<pipePrefix>-<port>`, which mirrors Firecracker's documented
 * `<uds_path>_<port>` rule for guest-initiated connections, so one listener
 * seam serves both hosts. Nothing in the path is interpreted: `net` treats a
 * `\\.\pipe\…` string as a pipe on Windows and as a filesystem socket
 * elsewhere, which is what lets this exact code be exercised on Linux.
 */
export const createGuestPipeListener = (): GuestChannelListener =>
  async (pipePrefix, port, onConnection) => {
    const socketPath = hyperVPipePath(pipePrefix, port)
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
    // A named pipe has no mode bits — its access is a DACL, and the pipe is
    // created with the daemon account's default one, which admits that account
    // and administrators. Only the POSIX stand-in used by the tests is chmodded.
    if (platform !== 'win32') await chmod(socketPath, 0o600)
    const listener: GuestVsockListener = {
      close: () => new Promise((resolvePromise) => { server.close(() => resolvePromise()) }),
      socketPath,
    }
    return listener
  }
