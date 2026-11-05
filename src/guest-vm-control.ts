import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

import {
  guestPayloadUnavailable as unavailable,
  isGuestRecord as isRecord,
  parseBrowserAction,
  parseBrowserObservation,
  parseBrowserOpen,
  parseCodingClose,
  parseCodingLaunch,
  parseCodingObservation,
  parseCommandResult,
  parseDraftChunk,
  parseDraftScan,
  parseInspection,
  GUEST_DRAFT_READ_MAX_BYTES,
} from './guest-vm-payloads.js'

import type {
  GuestBrowserAction,
  GuestBrowserActionResult,
  GuestBrowserObservation,
  GuestCodingAgent,
  GuestCodingObservation,
  GuestCommandRequest,
  GuestCommandResult,
  GuestDraftChunk,
  GuestDraftScan,
  GuestRuntimeInspection,
} from './guest-vm-payloads.js'

export type {
  GuestBrowserAction,
  GuestBrowserActionResult,
  GuestBrowserObservation,
  GuestCodingAgent,
  GuestCodingObservation,
  GuestCommandRequest,
  GuestCommandResult,
  GuestDraftChunk,
  GuestDraftEntry,
  GuestDraftScan,
  GuestRuntimeInspection,
} from './guest-vm-payloads.js'

const FRAME_MAX_BYTES = 65_536
const READY_MAX_BYTES = 4_096
const CONTROL_TIMEOUT_MS = 35_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (payload: Buffer) => void
  timeout: NodeJS.Timeout
  requestId: string
}

type GuestControlEnvelope = {
  kind: 'response'
  payload: Buffer
  requestId: string
}

const decodePayload = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  return Buffer.from(value, 'base64')
}

const decodeResponse = (frame: Buffer): GuestControlEnvelope => {
  let value: unknown
  try {
    value = JSON.parse(frame.toString('utf8'))
  } catch {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'payload', 'requestId', 'version'].includes(key))) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  if (value.kind !== 'response' || value.version !== 1 || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  return { kind: 'response', payload: decodePayload(value.payload), requestId: value.requestId }
}

const encodeRequest = (payload: Buffer, requestId: string): Buffer => {
  const body = Buffer.from(JSON.stringify({
    kind: 'request',
    payload: payload.toString('base64'),
    requestId,
    version: 1,
  }))
  if (body.length > FRAME_MAX_BYTES - 4) throw unavailable('The executor control request is too large.')
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

/** Owns the helper's private stdin/stdout framing after its one-use bootstrap. */
export class GuestVmControlClient {
  private output = Buffer.alloc(0)
  private closed = false
  private pending: PendingRequest | undefined
  private ready = false
  private readyError: Error | undefined
  private readonly readyPromise: Promise<void>
  private rejectReady: ((error: Error) => void) | undefined
  private resolveReady: (() => void) | undefined

  constructor(private readonly input: Writable, output: Readable) {
    this.readyPromise = new Promise<void>((resolvePromise, reject) => {
      this.resolveReady = resolvePromise
      this.rejectReady = reject
    })
    output.on('data', (chunk: Buffer) => this.receive(Buffer.from(chunk)))
    output.once('error', () => this.close(unavailable('The executor VM helper is unavailable.')))
    input.once('error', () => this.close(unavailable('The executor VM helper is unavailable.')))
  }

  waitForReady(timeoutMs: number): Promise<void> {
    const timeout = setTimeout(() => {
      this.close(unavailable('The executor VM helper timed out.'))
    }, timeoutMs)
    return this.readyPromise.finally(() => clearTimeout(timeout))
  }

  async inspectRuntime(): Promise<GuestRuntimeInspection> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'runtime.inspect', version: 1 })))
    return parseInspection(payload)
  }

  async openBrowser(url: string): Promise<void> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'browser.open', url, version: 1 })))
    parseBrowserOpen(payload)
  }

  async observeBrowser(includeScreenshot = false): Promise<GuestBrowserObservation> {
    const payload = await this.request(Buffer.from(JSON.stringify({ includeScreenshot, operation: 'browser.observe', version: 1 })))
    return parseBrowserObservation(payload)
  }

  async actBrowser(action: GuestBrowserAction): Promise<GuestBrowserActionResult> {
    const payload = await this.request(Buffer.from(JSON.stringify({ ...action, operation: 'browser.act', version: 1 })))
    return parseBrowserAction(payload)
  }

  async runCommand(request: GuestCommandRequest): Promise<GuestCommandResult> {
    const payload = await this.request(Buffer.from(JSON.stringify({ ...request, operation: 'command.run', version: 1 })))
    return parseCommandResult(payload)
  }

  async launchCodingSession(agent: GuestCodingAgent, prompt: string): Promise<void> {
    const payload = await this.request(Buffer.from(JSON.stringify({ agent, operation: 'coding.launch', prompt, version: 1 })))
    parseCodingLaunch(payload, agent)
  }

  async observeCodingSession(): Promise<GuestCodingObservation> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'coding.observe', version: 1 })))
    return parseCodingObservation(payload)
  }

  async closeCodingSession(): Promise<void> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'coding.close', version: 1 })))
    parseCodingClose(payload)
  }

  /**
   * Pages the draft overlay's changed entries. The block strategy gives the
   * guest a writable image rather than a share the host can read, so the only
   * way a draft reaches `sandbox-workspace.ts` is over this channel — the host
   * never parses ext4.
   */
  async scanDrafts(cursor: number): Promise<GuestDraftScan> {
    const payload = await this.request(
      Buffer.from(JSON.stringify({ cursor, operation: 'workspace.draft_scan', version: 1 })),
    )
    return parseDraftScan(payload)
  }

  async readDraft(path: string, offset: number): Promise<GuestDraftChunk> {
    const payload = await this.request(Buffer.from(JSON.stringify({
      maxResultBytes: GUEST_DRAFT_READ_MAX_BYTES,
      offset,
      operation: 'workspace.draft_read',
      path,
      version: 1,
    })))
    return parseDraftChunk(payload)
  }

  close(error: Error = unavailable('The executor VM helper closed its control pipe.')): void {
    if (this.closed) return
    this.closed = true
    if (!this.ready && !this.readyError) {
      this.readyError = error
      this.rejectReady?.(error)
    }
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.reject(error)
      this.pending = undefined
    }
  }

  private request(payload: Buffer): Promise<Buffer> {
    if (this.closed || !this.ready || this.readyError) return Promise.reject(unavailable('The executor VM helper is unavailable.'))
    if (this.pending) return Promise.reject(unavailable('The executor VM already has an active control request.'))
    if (payload.length > 32_768) return Promise.reject(unavailable('The executor control request is too large.'))
    const requestId = randomUUID()
    return new Promise<Buffer>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.close(unavailable('The executor guest timed out.'))
      }, CONTROL_TIMEOUT_MS)
      this.pending = { reject: reject, requestId, resolve: resolvePromise, timeout }
      this.input.write(encodeRequest(payload, requestId), (error) => {
        if (error) this.close(unavailable('The executor VM helper is unavailable.'))
      })
    })
  }

  private receive(chunk: Buffer): void {
    if (this.closed || this.readyError) return
    this.output = Buffer.concat([this.output, chunk])
    if (!this.ready) this.consumeReady()
    if (this.ready) this.consumeResponses()
  }

  private consumeReady(): void {
    if (this.output.length > READY_MAX_BYTES) {
      this.close(unavailable('The executor VM helper emitted invalid session output.'))
      return
    }
    const lineEnd = this.output.indexOf(0x0a)
    if (lineEnd < 0) return
    const line = this.output.subarray(0, lineEnd)
    this.output = this.output.subarray(lineEnd + 1)
    try {
      const value: unknown = JSON.parse(line.toString('utf8'))
      if (
        !isRecord(value)
        || Object.keys(value).some((key) => !['session', 'valid', 'workspaceAttached'].includes(key))
        || value.session !== 'ready'
        || value.valid !== true
        || value.workspaceAttached !== true
      ) {
        throw new Error('invalid ready response')
      }
      this.ready = true
      this.resolveReady?.()
    } catch {
      this.close(unavailable('The executor VM helper emitted invalid session output.'))
    }
  }

  private consumeResponses(): void {
    while (this.output.length >= 4) {
      const bodyLength = this.output.readUInt32BE(0)
      if (bodyLength > FRAME_MAX_BYTES - 4) {
        this.close(unavailable('The executor VM helper emitted an invalid control response.'))
        return
      }
      const frameLength = bodyLength + 4
      if (this.output.length < frameLength) return
      const frame = this.output.subarray(4, frameLength)
      this.output = this.output.subarray(frameLength)
      let response: GuestControlEnvelope
      try {
        response = decodeResponse(frame)
      } catch (error) {
        this.close(error instanceof Error ? error : unavailable('The executor VM helper is unavailable.'))
        return
      }
      if (!this.pending || response.requestId !== this.pending.requestId) {
        this.close(unavailable('The executor VM helper emitted an unexpected control response.'))
        return
      }
      const pending = this.pending
      this.pending = undefined
      clearTimeout(pending.timeout)
      pending.resolve(response.payload)
    }
  }
}
