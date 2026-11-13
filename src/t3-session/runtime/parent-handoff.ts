import type { Readable, Writable } from 'node:stream'
import { RetainedParentRequest, type RetainedParentStatus } from './daemon-handoff.js'

export const RETAINED_PARENT_FRAME_BYTES = 4096

/** Framing on the desktop's inherited liveness stdin and dedicated stdout.
 * No socket, executable selector, path selector or generic command is accepted.
 * Receipt validation/authority belongs to the actual daemon capture producer. */
export function attachRetainedParentHandoff(input: Readable, output: Writable,
  accept: (request: RetainedParentRequest) => void, retire: () => Promise<void>) {
  let buffered: Buffer = Buffer.alloc(0)
  let closed = false
  let retirement: Promise<void> | undefined
  const writes = new Set<Promise<void>>()
  const stop = () => {
    if (closed) return
    closed = true
    input.off('data', data)
    input.off('end', stop)
    input.off('close', stop)
    input.off('error', stop)
    buffered = Buffer.alloc(0)
    retirement = Promise.resolve().then(retire)
    void retirement.catch(() => undefined)
  }
  const report = (status: RetainedParentStatus) => {
    if (closed) return
    // At most the current bounded operation's acknowledgements can be pending.
    if (writes.size >= 8) { stop(); return }
    const pending = new Promise<void>((resolve, reject) => {
      output.write(`${JSON.stringify(status)}\n`, error => error ? reject(error) : resolve())
    })
    writes.add(pending)
    void pending.catch(stop).finally(() => { writes.delete(pending) })
  }
  const data = (chunk: Buffer | string) => {
    if (closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    // One begin plus one cancellation fit in the parent's bounded channel.
    if (buffered.length + bytes.length > RETAINED_PARENT_FRAME_BYTES * 2) { stop(); return }
    buffered = Buffer.concat([buffered, bytes])
    let count = 0
    for (let end = buffered.indexOf(10); end >= 0; end = buffered.indexOf(10)) {
      if (++count > 2 || end + 1 > RETAINED_PARENT_FRAME_BYTES) { stop(); return }
      const frame = buffered.subarray(0, end)
      buffered = buffered.subarray(end + 1)
      let request: RetainedParentRequest
      try {
        request = RetainedParentRequest.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)))
      } catch { stop(); return }
      // Only the runtime knows whether a prior producer still owns this ID.
      // A generic handler exception must never manufacture a terminal refusal.
      try { accept(request) } catch { stop(); return }
    }
    if (buffered.length >= RETAINED_PARENT_FRAME_BYTES) stop()
  }
  input.on('data', data)
  input.once('end', stop)
  input.once('close', stop)
  input.once('error', stop)
  output.on('error', stop)
  report({ version: 1, kind: 'retained-import', status: 'ready' })
  return {
    report,
    async close() {
      stop()
      let failure: unknown
      try { await retirement } catch (error) { failure = error }
      await Promise.allSettled([...writes])
      output.off('error', stop)
      if (failure) throw failure
    },
  }
}
