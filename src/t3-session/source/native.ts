import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { openSync, closeSync, readSync, writeSync } from 'node:fs'
import { packagedNativeHelperPath } from '../../state-security.js'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { SourceExchange } from './database.js'

const MAX_FRAME = 16 * 1024 * 1024

/** Private child stdin carries the MAC key; named pipes carry authenticated,
 * sequenced frames only. This module offers no injected executable or transport.
 */
export async function openNativeT3Source(request: Record<string, unknown>): Promise<{
  exchange: SourceExchange; close: () => void
}> {
  requireCapture(process.platform === 'win32', 't3_source_native_platform_unsupported')
  requireCapture(process.env.NESSIE_EXECUTOR_PACKAGED_CLI === '1', 't3_source_packaged_runtime_required')
  const nonce = randomBytes(32).toString('hex')
  const key = randomBytes(32)
  const expectedPipe = `\\\\.\\pipe\\nessie-t3-source-${nonce}`
  const child = spawn(packagedNativeHelperPath(), ['t3-source-read'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  })
  const deadline = Date.now() + 55_000
  let closed = false
  let exited = false
  let descriptor: number | undefined
  const close = () => {
    if (closed) return
    closed = true
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* Already disconnected. */ } }
    child.kill()
    key.fill(0)
  }
  try {
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
      const timer = setTimeout(() => finish(new CaptureFailure('t3_source_native_start_timeout')), 10_000)
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
    descriptor = openSync(expectedPipe, 'r+')
    let sequence = 0
    const transfer = (bytes: Buffer, write: boolean) => {
      requireCapture(!closed && !exited && descriptor !== undefined && Date.now() < deadline, 't3_source_lease_expired')
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
        requireCapture(!closed && Date.now() < deadline, 't3_source_lease_expired')
        return response.value
      } catch {
        close()
        throw new CaptureFailure('t3_source_resource_changed_or_unavailable')
      }
    }
    return { exchange, close }
  } catch {
    close()
    throw new CaptureFailure('t3_source_native_unavailable')
  }
}
