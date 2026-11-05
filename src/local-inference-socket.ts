import { WebSocket } from 'undici'
import {
  LOCAL_INFERENCE_PROTOCOL_VERSION, LOCAL_INFERENCE_SOCKET_PURPOSE, LOCAL_INFERENCE_SOCKET_REFUSED,
  LOCAL_INFERENCE_SOCKET_REPLACED, LocalInferenceServerSocketMessageSchema, type LocalInferenceEnvelopePurpose,
  type LocalInferenceServerSocketMessage, type LocalInferenceSocketRequestKind,
} from '@nessie/executor-protocol'
import {
  LOCAL_INFERENCE_SOCKET_PATH, localInferenceSocketSignedBody, signLocalInferenceEnvelope,
} from '@nessie/local-inference-host'

import { LocalInferenceApiError, localInferenceApiUrl, type LocalInferenceHostTransport } from './local-inference-api.js'
import type { LocalInferenceHostIdentity } from './local-inference-host.js'

const REQUEST_TIMEOUT_MS = 25_000
const FIRST_RETRY_MS = 1_000
const LAST_RETRY_MS = 30_000

/** The part of a WebSocket this client uses; undici's standard client in production. */
export type LocalInferenceSocketLike = {
  readonly readyState: number
  send: (data: string) => void
  close: (code: number, reason: string) => void
  listen: (handlers: { open: () => void; message: (data: unknown) => void; close: (code: number) => void }) => void
}
export type LocalInferenceSocketPush = Extract<LocalInferenceServerSocketMessage, { type: 'attempt_available' | 'control' }>
type Pending = { reject: (error: Error) => void; resolve: (data: unknown) => void; timer: NodeJS.Timeout }

const openWebSocket = (target: string): LocalInferenceSocketLike => {
  const socket = new WebSocket(target)
  return {
    get readyState() { return socket.readyState },
    send: (data) => { socket.send(data) },
    close: (code, reason) => { socket.close(code, reason) },
    listen: (handlers) => {
      socket.addEventListener('open', () => handlers.open())
      socket.addEventListener('message', (event) => handlers.message(event.data))
      socket.addEventListener('close', (event) => handlers.close(event.code))
      socket.addEventListener('error', () => undefined)
    },
  }
}
const parseJson = (data: string): unknown => { try { return JSON.parse(data) } catch { return undefined } }

/**
 * The host's one outbound socket to Nessie, kept open: it reconnects with
 * backoff and never polls. A drop rejects what was in flight as unreachable
 * (a lost answer the caller replays by its own token); a refusal ends it.
 */
export class LocalInferenceHostSocket implements LocalInferenceHostTransport {
  #socket: LocalInferenceSocketLike | null = null
  #connectionId: string | null = null
  #pending = new Map<number, Pending>()
  #sequences = new Map<LocalInferenceEnvelopePurpose, number>()
  #nextId = 1
  #retryMs = FIRST_RETRY_MS
  #retry: NodeJS.Timeout | null = null
  #stopped = false

  constructor(private readonly options: {
    apiBaseUrl: string
    identity: LocalInferenceHostIdentity
    challenge: () => Promise<string>
    onPush: (message: LocalInferenceSocketPush) => void
    onReady?: () => void
    onRefused?: () => void
    open?: (url: string) => LocalInferenceSocketLike
    requestTimeoutMs?: number
  }) {}

  get ready(): boolean { return this.#connectionId !== null }
  start(): void { void this.connect() }

  stop(): void {
    this.#stopped = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    const socket = this.#socket
    this.dropped('LOCAL_INFERENCE_API_CANCELLED')
    socket?.close(1000, 'Host stopped.')
  }

  claim: LocalInferenceHostTransport['claim'] = (poll) => this.request('claim', poll)
  accept: LocalInferenceHostTransport['accept'] = (control) => this.request('accept', control)
  result: LocalInferenceHostTransport['result'] = (receipt) => this.request('result', receipt)
  terminate: LocalInferenceHostTransport['terminate'] = (termination) => this.request('termination', termination)
  heartbeat: LocalInferenceHostTransport['heartbeat'] = (heartbeat) => this.request('heartbeat', heartbeat)
  attachResource: LocalInferenceHostTransport['attachResource'] = (resource) => this.request('resource', resource)

  /** Sent and forgotten; while disconnected a frame is dropped and the receipt carries its text. */
  frame: LocalInferenceHostTransport['frame'] = (frame) => {
    const socket = this.#socket
    if (!socket || this.#connectionId === null || socket.readyState !== 1) return
    socket.send(JSON.stringify({ type: 'frame', frame, envelope: this.sign(LOCAL_INFERENCE_SOCKET_PURPOSE.frame, frame) }))
  }

  private request<T>(kind: LocalInferenceSocketRequestKind, body: unknown): Promise<T> {
    const socket = this.#socket
    if (!socket || this.#connectionId === null || socket.readyState !== 1) {
      return Promise.reject(new LocalInferenceApiError('LOCAL_INFERENCE_API_UNREACHABLE'))
    }
    const id = this.#nextId++
    const envelope = this.sign(LOCAL_INFERENCE_SOCKET_PURPOSE[kind], body)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new LocalInferenceApiError('LOCAL_INFERENCE_API_TIMEOUT'))
        // An unanswered request is the sign of a dead connection: start again.
        if (this.#socket === socket) socket.close(4000, 'Request timed out.')
      }, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
      this.#pending.set(id, { reject, resolve: resolve as (data: unknown) => void, timer })
      socket.send(JSON.stringify({ type: 'request', id, kind, body, envelope }))
    })
  }

  /** After `connected`, every body is signed together with this connection's id. */
  private sign(purpose: LocalInferenceEnvelopePurpose, body: unknown, connection = this.#connectionId) {
    const { identity } = this.options
    const sequence = (this.#sequences.get(purpose) ?? 0) + 1
    this.#sequences.set(purpose, sequence)
    return signLocalInferenceEnvelope({
      body: connection === null ? body : localInferenceSocketSignedBody(connection, body),
      header: {
        connectionEpoch: identity.connectionEpoch, hostId: identity.hostId, organizationId: identity.organizationId,
        ...(identity.executorConnectionEpoch === undefined
          ? {} : { executorConnectionEpoch: identity.executorConnectionEpoch }),
        protocolVersion: LOCAL_INFERENCE_PROTOCOL_VERSION, purpose, sentAt: new Date().toISOString(), sequence,
      },
      machinePrivateKey: identity.machinePrivateKey,
    })
  }

  private async connect(): Promise<void> {
    if (this.#stopped) return
    let challenge: string
    try { challenge = await this.options.challenge() } catch (error) {
      const status = error instanceof LocalInferenceApiError ? error.status ?? 0 : 0
      // The challenge shares a per-address bucket with every daemon on the
      // network (60 per ten minutes): being told to slow down says nothing
      // about this host's authority, so wait the longest step and try again.
      // Treating it as a refusal made the executor claim afresh every twenty
      // seconds, two challenges a time, which kept the bucket empty for good.
      if (status === 429) { this.#retryMs = LAST_RETRY_MS; this.scheduleRetry(); return }
      if (status >= 400 && status < 500) this.refused()
      else this.scheduleRetry()
      return
    }
    if (this.#stopped) return
    const url = localInferenceApiUrl(this.options.apiBaseUrl, LOCAL_INFERENCE_SOCKET_PATH)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: LocalInferenceSocketLike
    try { socket = (this.options.open ?? openWebSocket)(url.toString()) } catch { this.scheduleRetry(); return }
    this.#socket = socket
    socket.listen({
      open: () => {
        socket.send(JSON.stringify({ type: 'connect', challenge, envelope: this.sign('claim', { challenge }, null) }))
      },
      message: (data) => this.receive(socket, data),
      close: (code) => this.closed(socket, code),
    })
  }

  private receive(socket: LocalInferenceSocketLike, data: unknown): void {
    if (socket !== this.#socket || typeof data !== 'string') return
    const parsed = LocalInferenceServerSocketMessageSchema.safeParse(parseJson(data))
    if (!parsed.success) { socket.close(4400, 'Malformed message.'); return }
    const message = parsed.data
    if (message.type === 'connected') {
      this.#connectionId = message.connectionId
      this.#retryMs = FIRST_RETRY_MS
      this.options.onReady?.()
    } else if (message.type === 'response' || message.type === 'error') {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.type === 'response') pending.resolve(message.data)
      else pending.reject(new LocalInferenceApiError(message.code, message.status))
    } else this.options.onPush(message)
  }

  private closed(socket: LocalInferenceSocketLike, code: number): void {
    if (socket !== this.#socket) return
    this.dropped('LOCAL_INFERENCE_API_UNREACHABLE')
    if (code === LOCAL_INFERENCE_SOCKET_REFUSED || code === LOCAL_INFERENCE_SOCKET_REPLACED) this.refused()
    else this.scheduleRetry()
  }

  private dropped(code: string): void {
    this.#socket = null
    this.#connectionId = null
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new LocalInferenceApiError(code))
    }
    this.#pending.clear()
  }

  private refused(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.options.onRefused?.()
  }

  private scheduleRetry(): void {
    if (this.#stopped || this.#retry) return
    // Jitter spreads a fleet of hosts reconnecting to a restarted replica.
    const delay = Math.round(this.#retryMs * (0.8 + Math.random() * 0.4))
    this.#retryMs = Math.min(this.#retryMs * 2, LAST_RETRY_MS)
    this.#retry = setTimeout(() => { this.#retry = null; void this.connect() }, delay)
    this.#retry.unref()
  }
}
