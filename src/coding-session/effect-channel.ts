import { createHash, randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { SessionEffectAuthority, SessionEffectRefused } from './session-effect-authority.js'
import type { ExecutorCodingSessionAuthority } from '@nessie/executor-protocol'

export type EffectKind = 'launch' | 'input' | 'reply' | 'terminal_reply' | 'end'
export type EffectWire = { kind: EffectKind; data: string; scope: ExecutorCodingSessionAuthority | null }
export const effectDigest = (wire: string): string => createHash('sha256').update(wire).digest('hex')
const LIMIT = 512 * 1024
const TIMEOUT = 10_000
export const automaticTerminalReply = (data: string): boolean =>
  data.length <= 64 && /^\u001b\[[0-9;?]*[Rcn]$/u.test(data)

/** Only provider responses, never new requests/notifications or human input, are independent of a new command. */
export const automaticProviderReply = (data: string): boolean => {
  try {
    const value = JSON.parse(data) as Record<string, unknown>
    return !!value && typeof value === 'object' && !Array.isArray(value) && !('method' in value)
      && (value.type === 'control_response' || ('id' in value && ('result' in value || 'error' in value)))
  } catch { return false }
}

export const sameEffectSession = (
  first: ExecutorCodingSessionAuthority, next: ExecutorCodingSessionAuthority,
): boolean => {
  const original = first.admissions[0]?.startCommandId ?? first.commandId
  const selected = next.admissions[0]?.startCommandId ?? next.commandId
  return first.executorId === next.executorId && first.originalOwnerGeneration === next.originalOwnerGeneration
    && first.ownerKey === next.ownerKey && first.connectionEpoch === next.connectionEpoch
    && first.authorizationRevision === next.authorizationRevision && original === selected && next.purpose === 'control'
    && (!first.admissions.length || !next.admissions.length
      || first.admissions[0]!.sessionId === next.admissions[0]!.sessionId
        && first.admissions[0]!.evidenceDigest === next.admissions[0]!.evidenceDigest)
}

/** Bounded framing on a private inherited pipe. It is never connected to provider stdio. */
export class EffectPipe {
  #buffer = ''
  #ended = false
  #messages: Record<string, unknown>[] = []
  #waiting?: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  constructor(readonly stream: Duplex) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      this.#buffer += chunk
      if (Buffer.byteLength(this.#buffer) > LIMIT) return this.close()
      for (;;) {
        const end = this.#buffer.indexOf('\n')
        if (end < 0) break
        const line = this.#buffer.slice(0, end)
        this.#buffer = this.#buffer.slice(end + 1)
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) return this.close()
          if (this.#waiting) {
            const pending = this.#waiting; this.#waiting = undefined; pending.resolve(value as Record<string, unknown>)
          } else {
            if (this.#messages.length >= 8) return this.close()
            this.#messages.push(value as Record<string, unknown>)
          }
        } catch { this.close(); return }
      }
    })
    stream.on('error', () => this.close())
    stream.on('close', () => this.close())
    stream.on('end', () => this.close())
  }
  send(value: unknown): void {
    const line = JSON.stringify(value) + '\n'
    if (this.#ended || Buffer.byteLength(line) > LIMIT) throw new SessionEffectRefused()
    this.stream.write(line)
  }
  async read(timeoutMs = TIMEOUT): Promise<Record<string, unknown>> {
    if (this.#ended || this.#waiting) throw new SessionEffectRefused()
    const queued = this.#messages.shift()
    if (queued) return queued
    let timer: NodeJS.Timeout | undefined
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#waiting = { resolve, reject }
        if (timeoutMs) timer = setTimeout(() => this.close(), timeoutMs)
      })
    } finally { clearTimeout(timer) }
  }
  close(): void {
    if (this.#ended) return
    this.#ended = true
    this.#waiting?.reject(new SessionEffectRefused())
    this.#waiting = undefined
    this.stream.destroy()
  }
}

/** Broker is the original host, never the provider. It signs only the exact pending frame's original authority. */
export class EffectBroker {
  #sequence = 0
  #queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly pipe: EffectPipe, private original: ExecutorCodingSessionAuthority) {}
  send(kind: EffectKind, data: string, effect?: SessionEffectAuthority): Promise<void> {
    const task = this.#queue.then(() => this.exchange(kind, data, effect))
    this.#queue = task.catch(() => undefined)
    return task
  }
  private async exchange(kind: EffectKind, data: string, effect?: SessionEffectAuthority): Promise<void> {
    if (effect && !sameEffectSession(this.original, effect.scope)) throw new SessionEffectRefused()
    if (!effect && kind !== 'end' && !(kind === 'reply' && automaticProviderReply(data))
      && !(kind === 'terminal_reply' && automaticTerminalReply(data))) throw new SessionEffectRefused()
    effect?.assertLive()
    if (effect?.scope.admissions.length && !this.original.admissions.length) this.original = effect.scope
    const seq = ++this.#sequence
    const wire = JSON.stringify({ kind, data, scope: effect?.scope ?? null } satisfies EffectWire)
    const digest = effectDigest(wire)
    const nonces = new Set<string>()
    this.pipe.send({ type: 'offer', seq, wire })
    try {
      for (;;) {
        const reply = await this.pipe.read()
        if (reply.seq !== seq || reply.digest !== digest) throw new SessionEffectRefused()
        if (reply.type === 'outcome') {
          if (reply.status !== 'accepted') throw new SessionEffectRefused()
          return
        }
        if (reply.type !== 'consume' || typeof reply.nonce !== 'string' || reply.nonce.length !== 36
          || nonces.has(reply.nonce) || nonces.size >= 8) throw new SessionEffectRefused()
        nonces.add(reply.nonce)
        try {
          await effect?.consume()
          effect?.assertLive()
          this.pipe.send({ type: 'permit', seq, digest, nonce: reply.nonce,
            validUntil: effect ? Date.parse(effect.scope.expiresAt) : Date.now() + 1_000 })
        } catch {
          this.pipe.send({ type: 'refuse', seq, digest, nonce: reply.nonce })
        }
      }
    } catch (error) { this.pipe.close(); throw error }
  }
}

/** Receiver requires a fresh challenge response immediately before each effect, including after local awaits. */
export class EffectReceiver {
  #sequence = 0
  #original?: ExecutorCodingSessionAuthority
  constructor(private readonly pipe: EffectPipe) {}
  async next(): Promise<{ frame: EffectWire; consume: () => Promise<void>; outcome: (status: string) => void }> {
    const offered = await this.pipe.read(this.#sequence === 0 ? TIMEOUT : 0)
    if (offered.type !== 'offer' || offered.seq !== this.#sequence + 1 || typeof offered.wire !== 'string') {
      throw new SessionEffectRefused()
    }
    const seq = ++this.#sequence, digest = effectDigest(offered.wire)
    const frame = JSON.parse(offered.wire) as EffectWire
    if (!frame || typeof frame.data !== 'string' || !['launch', 'input', 'reply', 'end'].includes(frame.kind)) {
      throw new SessionEffectRefused()
    }
    if (frame.scope) {
      // Schema validation, but no local fabricated authority. Only the broker can consume the signed owning route.
      const checked = SessionEffectAuthority.fromReference({ directory: '', authority: frame.scope })!
      checked.assertLive()
      if (this.#original && !sameEffectSession(this.#original, checked.scope)) throw new SessionEffectRefused()
      if (!this.#original || !this.#original.admissions.length && checked.scope.admissions.length) {
        this.#original = checked.scope
      }
    } else if (!this.#original || frame.kind !== 'end' && !(frame.kind === 'reply' && automaticProviderReply(frame.data))) {
      throw new SessionEffectRefused()
    }
    return { frame, consume: async () => {
      const nonce = randomUUID(), started = performance.now()
      this.pipe.send({ type: 'consume', seq, digest, nonce })
      const permit = await this.pipe.read()
      if (permit.type !== 'permit' || permit.seq !== seq || permit.digest !== digest || permit.nonce !== nonce
        || typeof permit.validUntil !== 'number' || permit.validUntil <= Date.now()
        || permit.validUntil > Date.now() + 5_000 || performance.now() - started >= 5_000) {
        throw new SessionEffectRefused()
      }
    }, outcome: status => this.pipe.send({ type: 'outcome', seq, digest, status }) }
  }
}
