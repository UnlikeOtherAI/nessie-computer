import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'


export class CodexOperationRejected extends Error {}

/** Bounded native app-server transport shared by account probes and session control. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<void> | undefined
  private nextId = 0
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly program: string, private readonly env: NodeJS.ProcessEnv) {}

  private start(): Promise<void> {
    this.ready ??= (async () => {
      const child = spawn(this.program, ['app-server', '--stdio'], { env: this.env, cwd: homedir(), windowsHide: true, stdio: 'pipe' })
      this.child = child
      // Stderr can contain provider paths or diagnostic content; drain without forwarding it.
      child.stderr.resume()
      let bytes = 0
      child.stdout.on('data', (data: Buffer) => {
        bytes += data.length
        if (bytes > 16 * 1024 * 1024) this.close()
      })
      createInterface({ input: child.stdout }).on('line', (line) => {
        bytes = 0
        if (line.length > 16 * 1024 * 1024) return
        let message: Record<string, unknown>
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object' || Array.isArray(value)) return
          message = value as Record<string, unknown>
        } catch { return }
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new CodexOperationRejected('Codex refused the requested operation.'))
        else pending.resolve(message.result)
      })
      const ended = (): void => {
        this.child = undefined
        this.ready = undefined
        for (const pending of this.pending.values()) {
          pending.reject(new Error('Codex connection ended; outcome unknown.'))
        }
        this.pending.clear()
      }
      child.once('error', ended)
      child.once('exit', ended)
      await this.request('initialize', {
        clientInfo: { name: 'nessie_executor', version: '1.0.0' }, capabilities: { experimentalApi: true },
      })
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    })()
    return this.ready
  }

  private request(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex timed out; outcome unknown.'))
        this.close()
      }, 15_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.close()
      })
    })
  }

  async call(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    await this.start()
    return this.request(method, params)
  }

  close(): void {
    // Only our metadata helper is owned here. No external provider process is signalled.
    this.child?.kill()
  }
}
