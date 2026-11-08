import { spawn } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { executionReceiptBytes, T3ExecutionReceiptSchema, T3ExecutionIssuerDescriptorSchema,
  T3ExecutionIssuerChallengeSchema, T3ExecutionSignedAdmissionSchema,
  T3_EXECUTION_ISSUER_DOMAIN, T3_EXECUTION_GRAPH_DOMAIN, T3_EXECUTION_RESERVATION_DOMAIN,
  T3_EXECUTION_PREPARATION_DOMAIN, T3_EXECUTION_ASSOCIATION_DOMAIN,
  type T3ExecutionReceipt, type T3ExecutionIssuerDescriptor, type T3ExecutionIssuerChallenge,
  type T3ExecutionSignedAdmission, type T3ExecutionGraph } from '@nessie/executor-protocol/t3-session'
import { packagedNativeHelperPath } from './state-security.js'

const refused = () => new Error('T3_NATIVE_EXECUTION_REFUSED')
type FiniteMode = 'offer' | 'enroll' | 'graph' | 'reserve' | 'prepare' | 'associate'

/** Fixed signed companion only. It authenticates its graph parent and service
 * before handling the payload. Timeout/abort/uncertain delivery is never retried.
 */
async function exchange(mode: FiniteMode, input: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') throw refused()
  const bytes = Buffer.from(JSON.stringify(input) + '\n')
  if (bytes.length > 65_536) throw refused()
  return new Promise((resolve, reject) => {
    const child = spawn(packagedNativeHelperPath(), ['t3-execution', mode], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let length = 0, failed = false
    const stop = () => { failed = true; child.kill() }
    const timer = setTimeout(stop, mode === 'enroll' ? 300_000 : 10_000)
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', stop)
    child.stdin.once('error', stop)
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > 65_536) stop()
      else chunks.push(chunk)
    })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (failed || signal?.aborted || code !== 0) { reject(refused()); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
      catch { reject(refused()) }
    })
    child.stdin.end(bytes)
    if (signal?.aborted) stop()
  })
}

/** Signature consistency only. This never enrolls a descriptor or grants an
 * operation; the backend trusts ONLY its explicitly approved current DB key.
 */
export function verifyT3ExecutionReceiptSignature(
  input: unknown, descriptor: T3ExecutionIssuerDescriptor,
): T3ExecutionReceipt {
  const receipt = T3ExecutionReceiptSchema.parse(input)
  const selected = T3ExecutionIssuerDescriptorSchema.parse(descriptor)
  const der = Buffer.from(selected.publicKey, 'base64')
  if (der.toString('base64') !== selected.publicKey
    || createHash('sha256').update(der).digest('hex') !== selected.keyId
    || receipt.keyId !== selected.keyId) throw refused()
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  const signature = Buffer.from(receipt.signature, 'base64url')
  if (key.asymmetricKeyType !== 'ed25519' || signature.toString('base64url') !== receipt.signature
    || !verify(null, executionReceiptBytes(receipt.domain, receipt.payload), key, signature)) throw refused()
  return receipt
}

export type T3NativeLaunchDescriptor = {
  command: string; args: string[]; cwd: string; environment: Record<string, string>
}

/** Machine-only transport for the original graph. The native gate remains the
 * authority. No caller-selected helper, signing callback, provider stdin or
 * native start method exists on this client.
 */
export async function createT3ExecutionNativeClient(executorId: string, signal?: AbortSignal) {
  const descriptor = T3ExecutionIssuerDescriptorSchema.parse(await exchange('offer', { executorId }, signal))
  if (descriptor.executorId !== executorId) throw refused()
  const capture = async (mode: Exclude<FiniteMode, 'offer'>, domain: T3ExecutionReceipt['domain'],
    input: unknown, cancellation?: AbortSignal): Promise<T3ExecutionReceipt> => {
    const receipt = verifyT3ExecutionReceiptSignature(await exchange(mode, input, cancellation), descriptor)
    if (receipt.domain !== domain) throw refused()
    return receipt
  }
  return Object.freeze({
    get descriptor() { return structuredClone(descriptor) },
    enroll: async (challenge: T3ExecutionIssuerChallenge, cancellation?: AbortSignal) => {
      const selected = T3ExecutionIssuerChallengeSchema.parse(challenge)
      const digest = 'sha256:' + createHash('sha256').update(canonicalExecutorJson(descriptor)).digest('hex')
      if (selected.executorId !== executorId || selected.pairedOrigin !== descriptor.pairedOrigin
        || selected.descriptorDigest !== digest) throw refused()
      return capture('enroll', T3_EXECUTION_ISSUER_DOMAIN, selected, cancellation)
    },
    graph: (inspection: T3ExecutionSignedAdmission, resourceId: string,
      graph: Omit<T3ExecutionGraph, 'custody'>, cancellation?: AbortSignal) =>
      capture('graph', T3_EXECUTION_GRAPH_DOMAIN,
        { inspection: T3ExecutionSignedAdmissionSchema.parse(inspection), resourceId, graph }, cancellation),
    reserve: (admission: T3ExecutionSignedAdmission, cancellation?: AbortSignal) =>
      capture('reserve', T3_EXECUTION_RESERVATION_DOMAIN,
        T3ExecutionSignedAdmissionSchema.parse(admission), cancellation),
    prepare: (reservationId: string, providerSessionId: string,
      launch: T3NativeLaunchDescriptor, cancellation?: AbortSignal) =>
      capture('prepare', T3_EXECUTION_PREPARATION_DOMAIN,
        { executorId, reservationId, providerSessionId, launch }, cancellation),
    associate: (admission: T3ExecutionSignedAdmission, cancellation?: AbortSignal) =>
      capture('associate', T3_EXECUTION_ASSOCIATION_DOMAIN,
        T3ExecutionSignedAdmissionSchema.parse(admission), cancellation),
  })
}
