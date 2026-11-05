import { createHmac, timingSafeEqual } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

import { WorkspacePathError } from '../workspace-paths.js'
import type { GuestChannelListener } from './control-channel.js'
import { listenGuestVsockPort, type GuestVsockListener } from './vsock.js'

/** The one guest-initiated egress port; identical to the macOS helper's. */
export const GUEST_EGRESS_PORT = 49_153

const PRELUDE_BYTES = 48
const PRELUDE_MAGIC = 'NEXG'
const PRELUDE_VERSION = 1
const PRELUDE_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_TUNNELS = 4
const EGRESS_TOKEN_CONTEXT = 'nessie-executor-egress-v1'
const BOOTSTRAP_TOKEN = /^[A-Za-z0-9_-]{43}$/

/**
 * The per-session egress credential, derived exactly as the guest derives it
 * (executor/guest/protocol.go `deriveEgressToken`): HMAC-SHA256 over a fixed
 * context string, keyed by the raw bootstrap token. It is distinct from the
 * one-use control hello, so a leaked tunnel cannot open a control channel.
 */
export const deriveGuestEgressToken = (bootstrapToken: string): string => {
  if (!BOOTSTRAP_TOKEN.test(bootstrapToken)) {
    throw new WorkspacePathError('The executor micro-VM bootstrap token is malformed.')
  }
  const key = Buffer.from(bootstrapToken, 'base64url')
  if (key.byteLength !== 32) throw new WorkspacePathError('The executor micro-VM bootstrap token is malformed.')
  return createHmac('sha256', key).update(EGRESS_TOKEN_CONTEXT).digest('base64url')
}

const preludeAccepted = (prelude: Buffer, expectedSessionToken: string): boolean => {
  if (prelude.byteLength !== PRELUDE_BYTES) return false
  if (prelude.subarray(0, 4).toString('ascii') !== PRELUDE_MAGIC) return false
  if (prelude[4] !== PRELUDE_VERSION) return false
  const expected = Buffer.from(expectedSessionToken, 'utf8')
  const offered = prelude.subarray(5)
  return offered.byteLength === expected.byteLength && timingSafeEqual(offered, expected)
}

const bridge = (guest: Socket, gateway: Socket): void => {
  guest.once('error', () => gateway.destroy())
  gateway.once('error', () => guest.destroy())
  guest.pipe(gateway)
  gateway.pipe(guest)
}

export type GuestEgressBridge = {
  close: () => Promise<void>
}

/**
 * Bridges authenticated guest tunnels to the daemon's existing owner-only
 * CONNECT gateway. Like the macOS bridge it relays bytes only: it understands
 * no HTTP, no origins, and no credentials — the gateway alone decides what a
 * tunnel may reach, so the guest still has exactly one route off the machine.
 */
export const startGuestEgressBridge = async (input: {
  bootstrapToken: string
  gatewaySocketPath: string
  /** Injected by the Hyper-V backend; Firecracker's own is the default. */
  listenPort?: GuestChannelListener
  vsockPath: string
}): Promise<GuestEgressBridge> => {
  const expectedSessionToken = deriveGuestEgressToken(input.bootstrapToken)
  const open = new Set<Socket>()
  let active = 0
  const admit = (guest: Socket): void => {
    if (active >= MAX_CONCURRENT_TUNNELS) {
      guest.destroy()
      return
    }
    active += 1
    open.add(guest)
    guest.once('close', () => {
      active -= 1
      open.delete(guest)
    })
    guest.once('error', () => guest.destroy())
    let prelude = Buffer.alloc(0)
    const timeout = setTimeout(() => guest.destroy(), PRELUDE_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      prelude = Buffer.concat([prelude, chunk])
      if (prelude.byteLength < PRELUDE_BYTES) return
      guest.off('data', onData)
      clearTimeout(timeout)
      const remainder = prelude.subarray(PRELUDE_BYTES)
      if (!preludeAccepted(prelude.subarray(0, PRELUDE_BYTES), expectedSessionToken)) {
        guest.destroy()
        return
      }
      guest.pause()
      const gateway = createConnection({ path: input.gatewaySocketPath })
      gateway.once('connect', () => {
        if (remainder.byteLength > 0) gateway.write(remainder)
        bridge(guest, gateway)
        guest.resume()
      })
      gateway.once('error', () => guest.destroy())
    }
    guest.on('data', onData)
  }
  const listen = input.listenPort ?? listenGuestVsockPort
  const listener: GuestVsockListener = await listen(input.vsockPath, GUEST_EGRESS_PORT, admit)
  return {
    close: async () => {
      await listener.close()
      for (const guest of [...open]) guest.destroy()
    },
  }
}
