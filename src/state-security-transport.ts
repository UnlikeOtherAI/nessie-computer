import { spawn, type ChildProcess } from 'node:child_process'

const MAX_REPLY_BYTES = 2_048
const REQUEST_TIMEOUT_MS = 10_000

type Pending = {
  id: number
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** A private child pipe reuses the process, never an ACL result. No operation is replayed after failure. */
export class StateSecurityTransport {
  readonly #child: ChildProcess
  #pending?: Pending
  #tail: Promise<void> = Promise.resolve()
  #buffer = ''
  #sequence = 0
  readonly #ended: Promise<void>

  #failure?: Error

  constructor(executable: string, args: readonly string[] = ['state-security-stdio']) {
    this.#child = spawn(executable, [...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.#ended = new Promise(resolve => this.#child.once('close', () => resolve()))
    this.#child.stdout!.setEncoding('utf8')
    this.#child.stdout!.on('data', (chunk: string) => this.#read(chunk))
    this.#child.stdin!.on('error', () => this.close())
    this.#child.stdout!.on('error', () => this.close())
    this.#child.on('error', () => this.close())
    this.#child.on('exit', () => this.close())
  }

  get closed(): boolean { return this.#failure !== undefined }

  /** Exit is observed before a scope returns to a native launch or custody check. */
  async stop(): Promise<void> {
    this.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.#ended, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The native state-security helper did not exit.')), 3_000)
      })])
    } finally { clearTimeout(timer) }
  }

  close(error = new Error('The native state-security channel ended before completing its check.')): void {
    if (this.#failure) return
    this.#failure = error

    const pending = this.#pending
    this.#pending = undefined
    if (pending) { clearTimeout(pending.timer); pending.reject(error) }
    this.#child.stdin?.destroy()
    this.#child.stdout?.destroy()
    this.#child.kill()
  }

  #read(chunk: string): void {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > MAX_REPLY_BYTES) { this.close(); return }
    const newline = this.#buffer.indexOf('\n')
    if (newline < 0) return
    const line = this.#buffer.slice(0, newline)
    this.#buffer = this.#buffer.slice(newline + 1)
    const pending = this.#pending
    let reply: unknown
    try { reply = JSON.parse(line) } catch { this.close(); return }
    if (!pending || this.#buffer.length || !reply || typeof reply !== 'object'
      || !('requestId' in reply) || reply.requestId !== pending.id
      || !('status' in reply) || !['secured', 'verified', 'rejected'].includes(String(reply.status))
      || !('code' in reply) || Object.keys(reply).length !== 3
      || (reply.status === 'rejected' ? typeof reply.code !== 'string' || !reply.code : reply.code !== null)) {
      this.close(); return
    }
    this.#pending = undefined
    clearTimeout(pending.timer)
    pending.resolve(line)
  }

  request(command: string, path: string): Promise<string> {

    const answer = this.#tail.then(() => {
      if (this.#failure) throw this.#failure
      const id = ++this.#sequence
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => this.close(new Error('The native state-security check timed out.')),
          REQUEST_TIMEOUT_MS)
        this.#pending = { id, resolve, reject, timer }
        this.#child.stdin!.write(JSON.stringify({ requestId: id, command, path }) + '\n')
      })
    })
    this.#tail = answer.then(() => undefined, () => undefined)
    return answer
  }
}
