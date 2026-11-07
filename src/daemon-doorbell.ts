import { WebSocket } from 'undici'
import {
  EXECUTOR_DAEMON_SOCKET_PATH, ExecutorDaemonSocketServerFrameSchema, type ExecutorDaemonSocketConnect,
  type ExecutorDaemonWakeTopic,
} from '@nessie/executor-protocol'

import { signExecutorDaemonPayload } from './daemon-signature.js'
import type { ExecutorLocalState } from './state-store.js'

/**
 * The daemon's doorbell: one WebSocket to Nessie on which only "run this
 * signed exchange now" travels (`executor-daemon-socket.ts` in the protocol).
 * Every payload keeps its signed HTTP path; the socket only changes when the
 * daemon asks.
 *
 * Its first message is the command poll's own signed proof, so the server
 * admits it exactly as it admits a poll. Anything but a `ready` frame leaves the daemon
 * on its one-second cadence: an older Nessie without the route refuses the
 * upgrade, the socket closes, and the daemon behaves as it always has. A
 * dropped socket reconnects with jittered, capped backoff; one that has never
 * once been ready backs off further, so an older server sees an upgrade
 * attempt every few minutes rather than every second.
 */

const FIRST_RETRY_MS = 1_000
const LAST_RETRY_MS = 60_000
/** After this many attempts without a single `ready`, the server most likely has no doorbell at all. */
const NEVER_READY_ATTEMPTS = 5
const NEVER_READY_RETRY_MS = 5 * 60_000

export type DoorbellSocketLike = {
  close: (code: number, reason: string) => void
  send: (data: string) => void
  listen: (handlers: { open: () => void; message: (data: unknown) => void; close: () => void }) => void
}

export type DoorbellState = Pick<ExecutorLocalState, 'apiBaseUrl' | 'executorId' | 'machinePrivateKey' | 'connectionEpoch'>

const openWebSocket = (url: string): DoorbellSocketLike => {
  const socket = new WebSocket(url)
  return {
    close: (code, reason) => { socket.close(code, reason) },
    send: (data) => { socket.send(data) },
    listen: (handlers) => {
      socket.addEventListener('open', () => handlers.open())
      socket.addEventListener('message', (event) => handlers.message(event.data))
      socket.addEventListener('close', () => handlers.close())
      // A refused upgrade or a network error is followed by `close`, which is where it is handled.
      socket.addEventListener('error', () => undefined)
    },
  }
}

const parseJson = (data: string): unknown => { try { return JSON.parse(data) } catch { return undefined } }

/** The poll's own signed proof, sent as the socket's first message. */
export const doorbellConnect = (
  state: DoorbellState, observedAt = new Date().toISOString(),
): ExecutorDaemonSocketConnect => {
  if (!state.connectionEpoch) throw new Error('The executor has not claimed a live daemon connection.')
  const payload = { connectionEpoch: state.connectionEpoch, executorId: state.executorId, observedAt }
  return { type: 'connect', ...payload, signature: signExecutorDaemonPayload(state.machinePrivateKey, 'poll', payload) }
}

export const doorbellUrl = (apiBaseUrl: string): string => {
  // The same join every daemon request uses, so a base URL with a path keeps it.
  const url = new URL(`${apiBaseUrl.replace(/\/$/u, '')}${EXECUTOR_DAEMON_SOCKET_PATH}`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** The wait before the next attempt, after `failures` closes in a row; jittered by ±20 %. */
export const doorbellRetryDelayMs = (
  failures: number, everReady: boolean, random: () => number = Math.random,
): number => {
  const cap = !everReady && failures >= NEVER_READY_ATTEMPTS ? NEVER_READY_RETRY_MS : LAST_RETRY_MS
  const base = Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), cap)
  // Jitter spreads a fleet of daemons reconnecting to a restarted replica.
  return Math.round(base * (0.8 + random() * 0.4))
}

export class ExecutorDaemonDoorbell {
  #socket: DoorbellSocketLike | null = null
  #ready = false
  #everReady = false
  #failures = 0
  #retry: NodeJS.Timeout | null = null
  #stopped = true

  constructor(private readonly options: {
    state: () => DoorbellState
    /** The socket is open and the daemon may poll every `pollSeconds`. */
    onReady: (pollSeconds: number) => void
    onWake: (topics: ExecutorDaemonWakeTopic[]) => void
    /** The socket closed or never opened: poll at the one-second cadence again. */
    onDown: () => void
    open?: (url: string) => DoorbellSocketLike
    /** Jitter in [0, 1); fixed in tests. */
    random?: () => number
  }) {}

  get ready(): boolean { return this.#ready }

  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    this.connect()
  }

  stop(): void {
    this.#stopped = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    this.drop()
  }

  /** A new connection epoch: the socket proved the old one, so it starts again at once. */
  restart(): void {
    if (this.#stopped) return
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    this.drop()
    this.#failures = 0
    this.connect()
  }

  private drop(): void {
    const socket = this.#socket
    this.#socket = null
    if (this.#ready) {
      this.#ready = false
      this.options.onDown()
    }
    socket?.close(1000, 'Daemon reconnecting.')
  }

  private connect(): void {
    if (this.#stopped) return
    const state = this.options.state()
    if (!state.connectionEpoch) { this.scheduleRetry(); return }
    let socket: DoorbellSocketLike
    try {
      socket = (this.options.open ?? openWebSocket)(doorbellUrl(state.apiBaseUrl))
    } catch {
      this.scheduleRetry()
      return
    }
    this.#socket = socket
    socket.listen({
      // Signed when the socket opens, so its observedAt is fresh however long the handshake took.
      open: () => {
        if (socket !== this.#socket) return
        try { socket.send(JSON.stringify(doorbellConnect(this.options.state()))) } catch { socket.close(1000, 'No live connection.') }
      },
      message: (data) => this.receive(socket, data),
      close: () => this.closed(socket),
    })
  }

  private receive(socket: DoorbellSocketLike, data: unknown): void {
    if (socket !== this.#socket || typeof data !== 'string') return
    const parsed = ExecutorDaemonSocketServerFrameSchema.safeParse(parseJson(data))
    // A frame this daemon cannot read changes nothing: the polls carry every payload anyway.
    if (!parsed.success) return
    const frame = parsed.data
    if (frame.type === 'ready') {
      this.#ready = true
      this.#everReady = true
      this.#failures = 0
      this.options.onReady(frame.pollSeconds)
    } else if (this.#ready) {
      this.options.onWake([...new Set(frame.topics)])
    }
  }

  private closed(socket: DoorbellSocketLike): void {
    if (socket !== this.#socket) return
    this.#socket = null
    if (this.#ready) {
      this.#ready = false
      this.options.onDown()
    }
    this.#failures += 1
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.#stopped || this.#retry) return
    const delay = doorbellRetryDelayMs(this.#failures, this.#everReady, this.options.random ?? Math.random)
    this.#retry = setTimeout(() => { this.#retry = null; this.connect() }, delay)
    this.#retry.unref()
  }
}
