import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { Options, Query, SDKUserMessage, SpawnOptions, Transport }
  from '@anthropic-ai/claude-agent-sdk'
import { createSessionNativeQuery } from './upstream/sdk.mjs'

export interface SessionClaudeProcess {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exitCode: number | null
  /** Actual process/Job clearance, independently observed by the native owner. */
  readonly closed: Promise<void>
  endInput(): Promise<void>
  terminate(): Promise<void>
}
export interface SessionClaudeWrite {
  write(signal: AbortSignal): Promise<void>
  discard(): Promise<void>
}
export type SessionClaudeDescriptor = Readonly<Omit<SpawnOptions, 'args' | 'env'>> & {
  readonly args: readonly string[]
  readonly env: Readonly<SpawnOptions['env']>
}
export interface SessionClaudeOwner {
  /** Actual original descriptor; this callback must use the admitted creator. */
  start(descriptor: SessionClaudeDescriptor, signal: AbortSignal): Promise<SessionClaudeProcess>
  /** Synchronous original-context capture, before any SDK callback/queue. This
   * is a consumer boundary, never a grant or a substitute for native FRAME. */
  capture(encoded: string): SessionClaudeWrite
}
declare const promptBrand: unique symbol
export interface SessionClaudePrompt {
  readonly [promptBrand]: true
  readonly type: 'user'
  readonly acknowledged: Promise<void>
}
export interface SessionClaudeInput {
  readonly messages: AsyncIterable<SessionClaudePrompt>
  /** Interrupt the actual original queue/take and join its cleanup. */
  interrupt(): Promise<void>
}
export interface SessionClaudeQuery {
  readonly query: Query
  readonly ready: Promise<void>
  capturePrompt(message: SDKUserMessage): SessionClaudePrompt
  streamInput(input: SessionClaudeInput): Promise<void>
  close(): Promise<void>
}

type Parser = (this: { processStdout: Readable; waitForExit(): Promise<void> }) => ReturnType<Transport['readMessages']>
const refused = () => new Error('SESSION_CLAUDE_NATIVE_REFUSED')
type Frame = {
  readonly captured: SessionClaudeWrite
  readonly bytes: Buffer
  readonly promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
  phase: 'held' | 'writing' | 'done'
}

/** Real SDK Query/encoder/parser, with no ChildProcess or Writable facade.
 * Tokens are immutable and private to this one graph/operation owner. */
export function createSessionClaudeQuery(options: Options, owner: SessionClaudeOwner,
  parentSignal: AbortSignal): SessionClaudeQuery {
  parentSignal.throwIfAborted()
  if (!options.pathToClaudeCodeExecutable || !options.env || !options.cwd
    || options.spawnClaudeCodeProcess || options.sessionStore || 'getOAuthToken' in options
    || 'getHostAuthToken' in options || 'onProcessSpawned' in options) throw refused()
  const abort = new AbortController()
  const sources = [parentSignal, ...(options.abortController ? [options.abortController.signal] : [])]
  for (const source of sources) source.throwIfAborted()
  const tokens = new WeakMap<object, Frame>()
  const held = new Set<Frame>(), tasks = new Set<Promise<unknown>>()
  let buffered = 0, total = 0, accepting = true, process: SessionClaudeProcess | undefined
  let firstFailure: unknown, closing: Promise<void> | undefined
  let termination: Promise<void> | undefined
  let inputOwner: SessionClaudeInput | undefined, inputStop: Promise<void> | undefined
  let query: Query | undefined
  let tail = Promise.resolve()
  const remember = (error: unknown) => { firstFailure ??= error }
  const terminateAndClear = async (child: SessionClaudeProcess) => {
    try { await child.terminate() } catch (error) { remember(error) }
    try { await child.closed } catch (error) { remember(error) }
  }
  const track = <A>(promise: Promise<A>): Promise<A> => {
    tasks.add(promise)
    void promise.finally(() => tasks.delete(promise)).catch(() => undefined)
    return promise
  }
  const current = () => { abort.signal.throwIfAborted(); if (!accepting) throw refused() }
  const release = (frame: Frame) => {
    if (!held.delete(frame)) return
    buffered -= frame.bytes.length
    frame.bytes.fill(0)
  }
  const discard = (frame: Frame, error: unknown) => track((async () => {
    if (frame.phase !== 'held') return
    frame.phase = 'done'
    frame.reject(error)
    try { await frame.captured.discard() } finally { release(frame) }
  })())
  const stop = () => {
    accepting = false
    abort.abort(refused())
    for (const frame of held) void discard(frame, refused()).catch(remember)
    if (inputOwner) {
      const originalInput = inputOwner
      inputStop ??= track(Promise.resolve().then(() => originalInput.interrupt()))
      void inputStop.catch(remember)
    }
    // A returned native child must be joined even if startup crossed abort.
    termination ??= track((async () => {
      try { await opened } catch { return }
      if (process) await terminateAndClear(process)
    })())
    void termination.catch(remember)
  }
  const cancel = () => { stop(); query?.close() }
  const capture = (encoded: string): object => {
    current()
    const bytes = Buffer.from(encoded, 'utf8')
    if (!bytes.length || bytes.length > 131_072 || bytes.at(-1) !== 10
      || bytes.subarray(0, -1).includes(10) || held.size >= 8
      || buffered + bytes.length > 262_144 || total >= 4095) {
      bytes.fill(0)
      const error = refused()
      remember(error); stop(); throw error
    }
    let captured: SessionClaudeWrite
    try { captured = owner.capture(encoded) } catch (error) {
      bytes.fill(0); remember(error); stop(); throw error
    }
    const deferred = Promise.withResolvers<void>()
    void deferred.promise.catch(() => undefined)
    const frame: Frame = { captured, bytes, ...deferred, phase: 'held' }
    const token = Object.freeze({ type: 'user' as const, acknowledged: deferred.promise })
    tokens.set(token, frame)
    held.add(frame)
    buffered += bytes.length
    total++
    return token
  }
  const frameFor = (token: object) => {
    const frame = tokens.get(token)
    if (!frame || frame.phase !== 'held') throw refused()
    return frame
  }
  let resolveOpened!: () => void, rejectOpened!: (error: unknown) => void
  const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject })
  void opened.catch(() => undefined)
  const write = (token: unknown): Promise<void> => {
    current()
    if (!token || typeof token !== 'object') throw refused()
    const frame = frameFor(token)
    frame.phase = 'writing'
    // Capture order differs from SDK scheduling order. Chain only actual write
    // invocations, while each SDK caller awaits its own native acknowledgment.
    const predecessor = tail
    const work = (async () => {
      try {
        await predecessor
        await opened
        current()
        await frame.captured.write(abort.signal)
        current()
        frame.resolve()
      } catch (error) { frame.reject(error); remember(error); stop(); throw error }
      finally {
        frame.phase = 'done'
        try { await frame.captured.discard() } catch (error) { remember(error); stop(); throw error }
        finally { release(frame) }
      }
    })()
    tail = work
    void work.catch(() => undefined)
    return track(work)
  }
  const hooks = {
    capture,
    prompt(token: object) {
      try { current(); frameFor(token); return token }
      catch (error) { remember(error); stop(); throw error }
    },
    open(descriptor: SpawnOptions, parser: Parser): Transport {
      const exact = Object.freeze({ ...descriptor, args: Object.freeze([...descriptor.args]),
        env: Object.freeze({ ...descriptor.env }) })
      track(Promise.resolve().then(async () => {
        current()
        process = await owner.start(exact, abort.signal)
        const child = process
        // Always drain stderr, even without a callback. Preserve the original
        // SDK's streaming UTF8 conversion across split native pipe chunks.
        track((async () => {
          const decoder = new StringDecoder('utf8')
          for await (const chunk of child.stderr) {
            if (!(chunk instanceof Uint8Array)) throw refused()
            const text = decoder.write(chunk)
            if (text) options.stderr?.(text)
          }
          const remaining = decoder.end()
          if (remaining) options.stderr?.(remaining)
        })()).catch(error => { remember(error); stop() })
        if (abort.signal.aborted) {
          // No parser starts on a cancelled launch, but the sole output reader
          // still drains while native termination/clearance is joined.
          track((async () => { for await (const _chunk of child.stdout) { /* discard cancelled output */ } })())
            .catch(remember)
          await terminateAndClear(process)
          throw refused()
        }
        resolveOpened()
      })).catch(error => { rejectOpened(error); remember(error); stop() })
      const waitForExit = async () => {
        await opened
        await process!.closed
        if (process!.exitCode !== 0) throw refused()
      }
      return {
        write,
        close: stop,
        isReady: () => accepting && process !== undefined,
        async *readMessages() {
          const drained = Promise.withResolvers<void>()
          track(drained.promise)
          try {
            await opened
            // Original readline, UTF8 and JSON parser; no process-shaped object.
            yield* parser.call({ processStdout: process!.stdout, waitForExit })
          } catch (error) {
            if (!abort.signal.aborted) { remember(error); stop() }
            throw error
          } finally { drained.resolve() }
        },
        endInput() {
          track(tail.then(async () => { await opened; current(); await process!.endInput() })).catch(error => {
            remember(error); stop()
          })
        },
        waitForExit,
      }
    },
  }
  for (const source of sources) source.addEventListener('abort', cancel, { once: true })
  let encodePrompt: (message: SDKUserMessage) => string
  try {
    const result = createSessionNativeQuery({ ...options, abortController: abort }, hooks)
    query = result.query
    encodePrompt = result.encodePrompt
    if (sources.some(signal => signal.aborted)) cancel()
  } catch (error) { rejectOpened(error); stop(); for (const source of sources) source.removeEventListener('abort', cancel)
    throw error }
  const actual = query
  const close = (): Promise<void> => closing ??= (async () => {
    stop()
    actual.close()
    await opened.catch(() => undefined)
    while (tasks.size) await Promise.allSettled([...tasks])
    if (process) {
      try { await process.closed } catch (error) { remember(error) }
    }
    for (const source of sources) source.removeEventListener('abort', cancel)
    if (firstFailure) throw firstFailure
  })()
  return Object.freeze({
    query: actual,
    ready: opened,
    capturePrompt(message: SDKUserMessage): SessionClaudePrompt {
      return capture(encodePrompt(message)) as SessionClaudePrompt
    },
    streamInput(input: SessionClaudeInput): Promise<void> {
      current()
      if (inputOwner || typeof input.interrupt !== 'function') throw refused()
      inputOwner = input
      // Only our tokens enter the original loop; no late reserialization.
      const work = actual.streamInput(input.messages as AsyncIterable<SDKUserMessage>)
      return track(work.catch(error => { remember(error); stop(); throw error }))
    },
    close,
  })
}
