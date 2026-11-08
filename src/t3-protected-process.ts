import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ProtectedGraphStartupSchema, T3ProtectedCompanionRoleSchema, T3ExecutionGenerationSchema,
  type T3ProtectedGraphStartup, type T3ProtectedCompanionRole } from '@nessie/executor-protocol/t3-session'
import { packagedNativeHelperPath } from './state-security.js'
import { ProtectedT3Process, protectedDeliveryUnknown } from './t3-protected-stream.js'

const companionPipe = String.raw`\\.\pipe\NessieT3ExecutionCompanion`
const readyDomain = 'nessie.t3.execution.creator-ready.v1'
type Startup = Omit<T3ProtectedGraphStartup, 'creatorKey'>
let binding: { startup: Startup; key: Buffer } | undefined
let startupRead = false

/** Own the first frame from SYSTEM-created stdin. There is no DTO setter.
 * Later runtime bytes are returned to stdin unchanged. The channel key never
 * leaves this module or becomes part of a runtime/source descriptor. */
export async function readProtectedT3GraphStartup(): Promise<Readonly<Startup>> {
  if (startupRead || process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') {
    throw protectedDeliveryUnknown()
  }
  startupRead = true
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => finish(protectedDeliveryUnknown()), 5000)
    const finish = (error?: Error, value?: Buffer) => {
      clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', data)
      process.stdin.off('error', fail)
      process.stdin.off('end', fail)
      if (error) { buffer.fill(0); reject(error) } else resolve(value!)
    }
    const fail = () => finish(protectedDeliveryUnknown())
    const data = (chunk: Buffer) => {
      if (buffer.length + chunk.length > 131_072) { fail(); return }
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0) { if (buffer.length > 65_536) fail(); return }
      if (newline > 65_536) { fail(); return }
      const rest = buffer.subarray(newline + 1)
      if (rest.length) process.stdin.unshift(rest)
      finish(undefined, buffer.subarray(0, newline))
    }
    process.stdin.on('data', data).once('error', fail).once('end', fail)
    process.stdin.resume()
  })
  try {
    const parsed = T3ProtectedGraphStartupSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (parsed.custody.runtime.pid !== process.pid) throw protectedDeliveryUnknown()
    const { creatorKey, ...startup } = parsed
    binding = { startup, key: Buffer.from(creatorKey, 'hex') }
    process.once('exit', () => binding?.key.fill(0))
    return Object.freeze(structuredClone(startup))
  } finally { bytes.fill(0) }
}

function cancellation(child: ProtectedT3Process, signal?: AbortSignal): void {
  const stop = () => { void child.terminate().catch(() => undefined) }
  signal?.addEventListener('abort', stop, { once: true })
  void child.closed.finally(() => signal?.removeEventListener('abort', stop)).catch(() => undefined)
  if (signal?.aborted) stop()
}

/** Finite fixed role selection is not an effect grant. The service separately
 * admits each native operation and compares its SYSTEM journal role. */
export async function spawnProtectedT3Companion(
  selected: T3ProtectedCompanionRole, signal?: AbortSignal,
): Promise<ProtectedT3Process> {
  signal?.throwIfAborted()
  const role = T3ProtectedCompanionRoleSchema.parse(selected)
  const current = binding
  if (!current || current.startup.custody.runtime.pid !== process.pid) throw protectedDeliveryUnknown()
  const nonce = randomBytes(32).toString('hex')
  const socket = createConnection(companionPipe)
  const child = new ProtectedT3Process({ input: socket, output: socket, dispose: () => socket.destroy() }, frame => {
    const { proof, ...ready } = frame
    if (frame.kind !== 'ready' || frame.graphId !== current.startup.graphId || frame.nonce !== nonce
      || frame.role !== role || typeof frame.creationId !== 'string' || !/^[a-f0-9]{64}$/u.test(frame.creationId)
      || typeof proof !== 'string' || !/^[a-f0-9]{64}$/u.test(proof)) throw protectedDeliveryUnknown()
    const expected = createHmac('sha256', current.key)
      .update(readyDomain + '\n' + canonicalExecutorJson(ready)).digest()
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw protectedDeliveryUnknown()
    return T3ExecutionGenerationSchema.parse(frame.child).pid
  })
  cancellation(child, signal)
  await child.sendInitial({ operation: 'companion', graphId: current.startup.graphId, nonce, role })
  signal?.throwIfAborted()
  return child
}

/** Only the installed native bootstrap may ask SYSTEM to start the fixed graph.
 * The bootstrap independently verifies its pipe server image/token; its parent
 * must be an actual registered daemon. No command, source path or key input. */
export async function startProtectedT3Graph(executorId: string, signal?: AbortSignal): Promise<ProtectedT3Process> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1'
    || !executorId || executorId.length > 512 || executorId.includes('\0')) throw protectedDeliveryUnknown()
  const bridge = spawn(packagedNativeHelperPath(), ['t3-execution-start', executorId], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const child = new ProtectedT3Process({ input: bridge.stdin, output: bridge.stdout,
    dispose: () => { bridge.kill() } }, frame => {
    if (frame.kind !== 'ready') throw protectedDeliveryUnknown()
    return T3ExecutionGenerationSchema.parse(frame.child).pid
  })
  bridge.stderr.resume()
  bridge.on('error', () => bridge.stdout.destroy(protectedDeliveryUnknown()))
  cancellation(child, signal)
  const timer = setTimeout(() => bridge.stdout.destroy(protectedDeliveryUnknown()), 10_000)
  try { await child.ready; signal?.throwIfAborted(); return child } finally { clearTimeout(timer) }
}

export type { ProtectedT3Process } from './t3-protected-stream.js'
