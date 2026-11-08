import type { SessionEffectAuthority } from './session-effect-authority.js'
/**
 * JSON-RPC over a `codex app-server` process's stdio, one message per line.
 * The host writes requests and answers the server's own requests; the
 * server's answers resolve the matching request, and everything else — its
 * notifications and its requests — is handed to the driver as it arrives.
 */

export type CodexServerRequest = { id: string | number; method: string; params: Record<string, unknown> }
export type CodexNotification = { method: string; params: Record<string, unknown> }

export class CodexRequestFailed extends Error {
  override readonly name = 'CodexRequestFailed'
  constructor(readonly method: string, readonly code: number | undefined) {
    super(`Codex refused ${method}.`)
  }
}

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

type Pending = {
  method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout
}

export class CodexAppConnection {
  #nextId = 1
  #pending = new Map<number, Pending>()

  constructor(
    private readonly write: (line: string, effect?: SessionEffectAuthority) => void | Promise<void>,
    private readonly timeoutMs = 60_000,
    private readonly reply: (line: string) => void = line => { void write(line) },
  ) {}

  request(method: string, params: Record<string, unknown>, effect?: SessionEffectAuthority): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CodexRequestFailed(method, undefined))
      }, this.timeoutMs)
      timer.unref()
      this.#pending.set(id, { method, resolve, reject, timer })
      Promise.resolve(this.write(`${JSON.stringify({ id, method, params })}\n`, effect)).catch(error => {
        clearTimeout(timer); this.#pending.delete(id); reject(error)
      })
    })
  }

  async notify(method: string, params?: Record<string, unknown>, effect?: SessionEffectAuthority): Promise<void> {
    await this.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`, effect)
  }

  async respond(id: string | number, result: Record<string, unknown>, effect?: SessionEffectAuthority): Promise<void> {
    const line = `${JSON.stringify({ id, result })}\n`
    if (effect) await this.write(line, effect)
    else this.reply(line)
  }

  respondError(id: string | number, message: string): void {
    this.reply(`${JSON.stringify({ id, error: { code: -32601, message } })}\n`)
  }

  /** One stdout line: an answer settles its request; a notification or a server request is returned. */
  accept(line: string): { notification?: CodexNotification; request?: CodexServerRequest } {
    let message: unknown
    try { message = JSON.parse(line) } catch { return {} }
    if (!record(message)) return {}
    const id = message.id
    if (typeof message.method === 'string') {
      const params = record(message.params) ? message.params : {}
      if (typeof id === 'number' || typeof id === 'string') return { request: { id, method: message.method, params } }
      return { notification: { method: message.method, params } }
    }
    if (typeof id !== 'number') return {}
    const pending = this.#pending.get(id)
    if (!pending) return {}
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      const code = record(message.error) && typeof message.error.code === 'number' ? message.error.code : undefined
      pending.reject(new CodexRequestFailed(pending.method, code))
    } else pending.resolve(message.result)
    return {}
  }

  /** The process is gone: every request still waiting fails. */
  failAll(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexRequestFailed(pending.method, undefined))
    }
    this.#pending.clear()
  }
}
