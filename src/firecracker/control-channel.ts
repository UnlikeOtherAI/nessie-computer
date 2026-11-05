import { timingSafeEqual } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Socket } from 'node:net'

import { WorkspacePathError } from '../workspace-paths.js'
import { listenGuestVsockPort, type GuestVsockListener } from './vsock.js'

/**
 * How a backend accepts a guest-initiated connection on one port. Firecracker
 * bridges guest `AF_VSOCK` onto host Unix sockets and is the default; the
 * Hyper-V backend hands in a named-pipe listener whose other end is the
 * `AF_HYPERV` bridge. Everything below this line — the hello frame, the
 * constant-time token check, the one-connection rule — is the same code on both
 * hosts, which is the point of the seam.
 */
export type GuestChannelListener = (
  path: string,
  port: number,
  onConnection: (socket: Socket) => void,
) => Promise<GuestVsockListener>

/** The one guest-initiated control port; identical to the macOS helper's. */
export const GUEST_CONTROL_PORT = 49_152

const FRAME_MAX_BYTES = 65_536
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]{43}$/

/**
 * The ready line `GuestVmControlClient` waits for. On macOS the Swift helper
 * prints it once the guest hello has authenticated; here the same authenticated
 * moment produces the same line, so the client above is byte-identical.
 */
const READY_LINE = `${JSON.stringify({ session: 'ready', valid: true, workspaceAttached: true })}\n`

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/**
 * Reads exactly one guest hello envelope out of the accumulated stream. The
 * frame format is the guest's own (executor/guest/protocol.go): a 4-byte
 * big-endian length followed by the JSON envelope, whose `payload` is base64
 * and whose `sessionToken` appears on the hello and nowhere else.
 */
const consumeHello = (
  buffered: Buffer,
  expectedBootstrapToken: string,
): { remainder: Buffer } | undefined => {
  if (buffered.byteLength < 4) return undefined
  const bodyLength = buffered.readUInt32BE(0)
  if (bodyLength > FRAME_MAX_BYTES - 4) {
    throw new WorkspacePathError('The executor guest sent an oversized control hello.')
  }
  if (buffered.byteLength < bodyLength + 4) return undefined
  let value: unknown
  try {
    value = JSON.parse(buffered.subarray(4, bodyLength + 4).toString('utf8'))
  } catch {
    throw new WorkspacePathError('The executor guest sent an invalid control hello.')
  }
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !['kind', 'payload', 'requestId', 'sessionToken', 'version'].includes(key))
    || value.kind !== 'hello'
    || value.version !== 1
    || value.payload !== ''
    || typeof value.requestId !== 'string'
    || typeof value.sessionToken !== 'string'
    || !BOOTSTRAP_TOKEN.test(value.sessionToken)
    || !constantTimeEqual(value.sessionToken, expectedBootstrapToken)
  ) {
    throw new WorkspacePathError('The executor guest failed its control authentication.')
  }
  return { remainder: buffered.subarray(bodyLength + 4) }
}

export type GuestControlChannel = {
  close: () => Promise<void>
  /** Resolves with the authenticated guest stream pair, or rejects. */
  connected: Promise<{ input: Socket; output: PassThrough }>
}

/**
 * Owns the one control channel for a Firecracker session. Only the first guest
 * connection is admitted; a second is destroyed rather than allowed to replace
 * a live channel, mirroring `GuestControlListener` on macOS. The token check
 * happens here, before a single byte reaches `GuestVmControlClient`.
 */
export const startGuestControlChannel = async (
  vsockPath: string,
  expectedBootstrapToken: string,
  listenPort: GuestChannelListener = listenGuestVsockPort,
): Promise<GuestControlChannel> => {
  if (!BOOTSTRAP_TOKEN.test(expectedBootstrapToken)) {
    throw new WorkspacePathError('The executor micro-VM bootstrap token is malformed.')
  }
  let settle: ((value: { input: Socket; output: PassThrough }) => void) | undefined
  let refuse: ((error: Error) => void) | undefined
  let admitted = false
  const connected = new Promise<{ input: Socket; output: PassThrough }>((resolvePromise, reject) => {
    settle = resolvePromise
    refuse = reject
  })
  // Nothing may await this before `connected` is handed to a caller; a rejected
  // promise with no reader is an unhandled rejection, so it is silenced here
  // and the real error surfaces to whoever awaits it.
  connected.catch(() => undefined)
  let listener: GuestVsockListener | undefined
  const admit = (socket: Socket): void => {
    if (admitted) {
      socket.destroy()
      return
    }
    admitted = true
    const output = new PassThrough()
    let buffered = Buffer.alloc(0)
    let authenticated = false
    const onData = (chunk: Buffer): void => {
      if (authenticated) return
      buffered = Buffer.concat([buffered, chunk])
      let hello: { remainder: Buffer } | undefined
      try {
        hello = consumeHello(buffered, expectedBootstrapToken)
      } catch (error) {
        socket.off('data', onData)
        socket.destroy()
        refuse?.(error as Error)
        return
      }
      if (!hello) return
      authenticated = true
      socket.off('data', onData)
      output.write(READY_LINE)
      if (hello.remainder.byteLength > 0) output.write(hello.remainder)
      socket.pipe(output)
      settle?.({ input: socket, output })
    }
    socket.on('data', onData)
    socket.once('error', () => refuse?.(new WorkspacePathError('The executor guest control channel failed.')))
    socket.once('close', () => {
      output.end()
      refuse?.(new WorkspacePathError('The executor guest closed its control channel before authenticating.'))
    })
  }
  listener = await listenPort(vsockPath, GUEST_CONTROL_PORT, admit)
  return {
    close: async () => {
      await listener?.close()
      refuse?.(new WorkspacePathError('The executor guest control channel was closed.'))
    },
    connected,
  }
}
