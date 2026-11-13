import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { openSync, closeSync, readSync, writeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { packagedNativeHelperPath } from '../../state-security.js'
import { spawnProtectedT3Companion } from '../../t3-protected-process.js'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { SourceExchange } from './database.js'

const MAX_FRAME = 16 * 1024 * 1024

/** Private child stdin carries the MAC key; named pipes carry authenticated,
 * sequenced frames only. This module offers no injected executable or transport.
 */
export async function openNativeT3Source(request: Record<string, unknown>): Promise<{
  exchange: SourceExchange; close: () => Promise<void>
}> {
  return openNativeSourceChannel(request, 't3-source-read')
}

/** Only the service-authenticated fixed graph process can pass this command's
 * native gate. The retained reader cannot request its settings opcode. */
export async function openNativeT3ExecutionResources(request: Record<string, unknown>, signal?: AbortSignal): Promise<{
  exchange: SourceExchange; close: () => Promise<void>
}> {
  return openNativeSourceChannel(request, 't3-execution-resource', signal)
}

async function openNativeSourceChannel(request: Record<string, unknown>,
  command: 't3-source-read' | 't3-execution-resource', signal?: AbortSignal): Promise<{
    exchange: SourceExchange; close: () => Promise<void>
  }> {
  requireCapture(process.platform === 'win32', 't3_source_native_platform_unsupported')
  requireCapture(process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1', 't3_source_packaged_runtime_required')
  signal?.throwIfAborted()
  const nonce = randomBytes(32).toString('hex')
  const expectedPipe = `\\\\.\\pipe\\nessie-t3-source-${nonce}`
  const protectedChild = command === 't3-execution-resource' ? await spawnProtectedT3Companion('resource', signal) : undefined
  const localChild = command === 't3-source-read' ? spawn(packagedNativeHelperPath(), ['t3-source-read'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  }) : undefined
  const child = protectedChild ?? localChild
  requireCapture(child, 't3_source_native_unavailable')
  const key = randomBytes(32)
  // A protected process exit is insufficient. Its facade resolves only after
  // the actual SYSTEM creator confirms that its native resources are cleared.
  const childClosed = protectedChild?.closed ?? new Promise<void>(resolve => { child.once('close', () => resolve()) })
  let deadline = performance.now() + 55_000
  let closed = false
  let exited = false
  let descriptor: number | undefined
  let closing: Promise<void> | undefined
  void childClosed.catch(() => { exited = true })
  const close = () => {
    if (closing) return closing
    closed = true
    signal?.removeEventListener('abort', onAbort)
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* Already disconnected. */ } }
    key.fill(0)
    if (protectedChild) closing = protectedChild.terminate().then(() => childClosed)
    else { localChild?.kill(); closing = childClosed }
    // Background invalidation is best effort; the owning finally awaits this
    // same promise and surfaces failure to obtain positive clearance.
    void closing.catch(() => {})
    return closing
  }
  const onAbort = () => { void close() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      let output = ''
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new CaptureFailure('t3_source_native_start_timeout')),
        command === 't3-execution-resource' ? 300_000 : 10_000)
      child.once('error', () => finish(new CaptureFailure('t3_source_native_unavailable')))
      child.once('exit', () => {
        if (!settled) finish(new CaptureFailure('t3_source_native_unavailable'))
        exited = true
      })
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > 4096) return finish(new CaptureFailure('t3_source_native_protocol_invalid'))
        if (!output.includes('\n')) return
        try {
          const answer = JSON.parse(output) as { protocol?: number; pipe?: string }
          requireCapture(answer.protocol === 1 && answer.pipe === expectedPipe, 't3_source_native_protocol_invalid')
          finish()
        } catch { finish(new CaptureFailure('t3_source_native_unavailable')) }
      })
      child.stdin.on('error', () => finish(new CaptureFailure('t3_source_native_unavailable')))
      child.stdin.end(JSON.stringify({ ...request, nonce, secret: key.toString('hex'), parentPid: process.pid }))
    })
    signal?.throwIfAborted()
    // Execution startup may contain a bounded secure-desktop source-link
    // ceremony. The transport idle lease begins only after its held receipt.
    deadline = performance.now() + 55_000
    descriptor = openSync(expectedPipe, 'r+')
    let sequence = 0
    const transfer = (bytes: Buffer, write: boolean) => {
      requireCapture(!closed && !exited && descriptor !== undefined && performance.now() < deadline,
        't3_source_lease_expired')
      for (let offset = 0; offset < bytes.length;) {
        const count = write ? writeSync(descriptor, bytes, offset, bytes.length - offset)
          : readSync(descriptor, bytes, offset, bytes.length - offset, null)
        requireCapture(count > 0, 't3_source_native_disconnected')
        offset += count
      }
    }
    const mac = (direction: string, body: string): string => createHmac('sha256', key)
      .update(`t3-source-v1:${direction}:${sequence}:`).update(body).digest('hex')
    const exchange: SourceExchange = message => {
      try {
        sequence += 1
        requireCapture(Number.isSafeInteger(sequence), 't3_source_sequence_exhausted')
        const body = JSON.stringify(message)
        const bytes = Buffer.from(JSON.stringify({ sequence, body, mac: mac('request', body) }))
        requireCapture(bytes.length <= MAX_FRAME, 't3_source_frame_too_large')
        const size = Buffer.alloc(4)
        size.writeUInt32LE(bytes.length)
        transfer(size, true); transfer(bytes, true)
        transfer(size, false)
        const length = size.readUInt32LE()
        requireCapture(length > 0 && length <= MAX_FRAME, 't3_source_frame_too_large')
        const reply = Buffer.alloc(length)
        transfer(reply, false)
        const frame = JSON.parse(reply.toString('utf8')) as { sequence: number; body: string; mac: string }
        requireCapture(frame.sequence === sequence && typeof frame.body === 'string'
          && /^[a-f0-9]{64}$/u.test(frame.mac), 't3_source_native_protocol_invalid')
        requireCapture(timingSafeEqual(Buffer.from(frame.mac, 'hex'), Buffer.from(mac('response', frame.body), 'hex')),
          't3_source_native_protocol_invalid')
        const response = JSON.parse(frame.body) as { ok: boolean; value: Record<string, unknown> }
        requireCapture(response.ok === true && response.value && typeof response.value === 'object',
          't3_source_resource_changed_or_unavailable')
        requireCapture(!closed && performance.now() < deadline, 't3_source_lease_expired')
        // The receiver renewed only after fresh config/handle/ACL checks. This
        // renews no human grant and permits long captures without skipping rows.
        deadline = performance.now() + 55_000
        return response.value
      } catch {
        void close()
        throw new CaptureFailure('t3_source_resource_changed_or_unavailable')
      }
    }
    return { exchange, close }
  } catch {
    await close()
    throw new CaptureFailure('t3_source_native_unavailable')
  }
}
