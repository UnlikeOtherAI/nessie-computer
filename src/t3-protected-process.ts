import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createConnection } from 'node:net'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { T3ProtectedGraphStartupSchema, T3ProtectedCompanionRoleSchema, T3ExecutionGenerationSchema,
  type T3ProtectedGraphStartup, type T3ProtectedCompanionRole } from '@nessie/executor-protocol/t3-session'
import { T3ExecutionSignedAdmissionSchema, T3ExecutionAdmissionSchema,
  type T3ExecutionSignedAdmission } from '@nessie/executor-protocol/t3-session'
import { packagedNativeHelperPath } from './state-security.js'
import { ProtectedT3Process, protectedDeliveryUnknown } from './t3-protected-stream.js'
import { ProtectedT3Provider } from './t3-protected-provider.js'
import { T3ExecutionSecretDeliveryHeaderSchema, T3ExecutionSecretReadAdmissionSchema,
  T3_EXECUTION_SECRET_DELIVERY_DOMAIN, T3_EXECUTION_SECRET_INSTALLED_DOMAIN,
  type T3ExecutionSecretReadAdmission } from '@nessie/executor-protocol/t3-session'

const companionPipe = String.raw`\\.\pipe\NessieT3ExecutionCompanion`
const readyDomain = 'nessie.t3.execution.creator-ready.v1'
type Startup = Omit<T3ProtectedGraphStartup, 'creatorKey'>
let binding: { startup: Startup; key: Buffer } | undefined
let startupRead = false
declare const secretDeliveryBrand: unique symbol
export type VerifiedT3SecretDelivery = { readonly [secretDeliveryBrand]: true }
const secretDeliveries = new WeakMap<VerifiedT3SecretDelivery, T3ExecutionSecretReadAdmission>()
const deliveredSecretSlots = new Set<string>()

/** Private sink verification only. Does not open a channel, return a value,
 * enroll a callback or authorize a read. Native independently consumes admission. */
export function verifyProtectedT3SecretDelivery(
  headerBytes: Uint8Array, value: Uint8Array, proof: Uint8Array, expected: T3ExecutionSignedAdmission,
): VerifiedT3SecretDelivery {
  const current = binding
  const envelope = T3ExecutionSignedAdmissionSchema.parse(expected)
  const selected = T3ExecutionSecretReadAdmissionSchema.parse(JSON.parse(envelope.payload))
  if (!current || headerBytes.length === 0 || headerBytes.length > 4096 || proof.length !== 32
    || value.length > selected.maxValueBytes || Date.now() < selected.issuedAtMs
    || Date.now() >= selected.expiresAtMs) throw protectedDeliveryUnknown()
  const header = T3ExecutionSecretDeliveryHeaderSchema.parse(JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(headerBytes)))
  if (header.graphId !== current.startup.graphId || header.readId !== selected.readId
    || header.slotId !== selected.recipient.slotId || header.nonce !== selected.nonce
    || header.admissionDigest !== 'sha256:' + createHash('sha256').update(envelope.payload).digest('hex')
    || header.expiresAtMs !== selected.expiresAtMs || header.byteLength !== value.length
    || canonicalExecutorJson(header.recipient) !== canonicalExecutorJson(current.startup.custody.runtime)
    || canonicalExecutorJson(header.recipient) !== canonicalExecutorJson(selected.recipient.generation)
    || canonicalExecutorJson(selected.evidence.custody) !== canonicalExecutorJson(current.startup.custody)
    || selected.binding.executorId !== current.startup.executorId) throw protectedDeliveryUnknown()
  // Lengths are included in the MAC. No ambiguous concatenation or value hash
  // escapes through metadata. Buffers remain owned by the private runtime sink.
  const lengths = Buffer.alloc(8)
  lengths.writeUInt32LE(headerBytes.length, 0)
  lengths.writeUInt32LE(value.length, 4)
  const mac = createHmac('sha256', current.key).update(T3_EXECUTION_SECRET_DELIVERY_DOMAIN + '\n')
    .update(lengths.subarray(0, 4)).update(headerBytes).update(lengths.subarray(4)).update(value).digest()
  if (!timingSafeEqual(mac, proof) || Date.now() >= selected.expiresAtMs) throw protectedDeliveryUnknown()
  const slot = canonicalExecutorJson({ sourceEvidenceDigest: selected.binding.sourceEvidenceDigest,
    acceptedGraphNonce: selected.acceptedGraphNonce, environmentIndex: selected.slot.index })
  if (deliveredSecretSlots.has(slot) || deliveredSecretSlots.size >= 4096) throw protectedDeliveryUnknown()
  deliveredSecretSlots.add(slot)
  const delivery = Object.freeze({}) as VerifiedT3SecretDelivery
  secretDeliveries.set(delivery, selected)
  return delivery
}

/** Nonsecret acknowledgement, called only AFTER the private scoped installer.
 * Service treats lost/late ACK as consumed unknown delivery, never a retry. */
export function protectedT3SecretInstalledFrame(delivery: VerifiedT3SecretDelivery): Buffer {
  const current = binding, selected = secretDeliveries.get(delivery)
  secretDeliveries.delete(delivery)
  if (!current || !selected || Date.now() >= selected.expiresAtMs
    || selected.binding.executorId !== current.startup.executorId
    || canonicalExecutorJson(selected.recipient.generation)
      !== canonicalExecutorJson(current.startup.custody.runtime)) {
    throw protectedDeliveryUnknown()
  }
  const header = Buffer.from(canonicalExecutorJson({ version: 1, type: 't3.secret.installed',
    graphId: current.startup.graphId, readId: selected.readId, slotId: selected.recipient.slotId,
    nonce: selected.nonce, expiresAtMs: selected.expiresAtMs }))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(header.length)
  const proof = createHmac('sha256', current.key).update(T3_EXECUTION_SECRET_INSTALLED_DOMAIN + '\n')
    .update(length).update(header).digest()
  return Buffer.concat([length, header, proof])
}

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
  const socket = createConnection(companionPipe + '-' + current.startup.graphId)
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

/** SYSTEM chooses only the currently service-held, phase-admitted descriptor.
 * The graph supplies neither an executable nor a launch permission boolean. */
export async function startProtectedT3Provider(
  input: T3ExecutionSignedAdmission, signal?: AbortSignal,
): Promise<ProtectedT3Provider> {
  signal?.throwIfAborted()
  const admission = T3ExecutionSignedAdmissionSchema.parse(input)
  const selected = T3ExecutionAdmissionSchema.parse(JSON.parse(admission.payload))
  const current = binding
  if (!current || selected.phase !== 'launch' || selected.binding.executorId !== current.startup.executorId
    || current.startup.custody.runtime.pid !== process.pid) throw protectedDeliveryUnknown()
  const nonce = randomBytes(32).toString('hex')
  const socket = createConnection(companionPipe + '-' + current.startup.graphId)
  const child = new ProtectedT3Process({ input: socket, output: socket, dispose: () => socket.destroy() }, frame => {
    const { proof, ...ready } = frame
    if (frame.kind !== 'ready' || frame.graphId !== current.startup.graphId || frame.nonce !== nonce
      || frame.processPurpose !== selected.processPurpose || frame.reservationId !== selected.reservationId
      || typeof frame.creationId !== 'string' || !/^[a-f0-9]{64}$/u.test(frame.creationId)
      || typeof proof !== 'string' || !/^[a-f0-9]{64}$/u.test(proof)) throw protectedDeliveryUnknown()
    const expected = createHmac('sha256', current.key)
      .update(readyDomain + '\n' + canonicalExecutorJson(ready)).digest()
    if (!timingSafeEqual(expected, Buffer.from(proof, 'hex'))) throw protectedDeliveryUnknown()
    return T3ExecutionGenerationSchema.parse(frame.child).pid
  }, 'finite')
  const provider = new ProtectedT3Provider(child)
  cancellation(child, signal)
  await child.sendInitial({ operation: 'provider', graphId: current.startup.graphId, nonce, admission })
  signal?.throwIfAborted()
  return provider
}
export type { ProtectedT3Provider } from './t3-protected-provider.js'
