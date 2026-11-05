import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

import {
  canonicalExecutorJson,
  canonicalExecutorPayload,
  LocalInferenceEnvelopeCoreSchema,
  LocalInferenceSignedEnvelopeSchema,
  type LocalInferenceEnvelopeCore,
  type LocalInferenceEnvelopeCoreInput,
  type LocalInferenceSignedEnvelope,
} from '@nessie/executor-protocol'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const signedCore = (envelope: LocalInferenceEnvelopeCore): LocalInferenceEnvelopeCore => ({
  bodyDigest: envelope.bodyDigest,
  connectionEpoch: envelope.connectionEpoch,
  ...(envelope.executorConnectionEpoch === undefined
    ? {}
    : { executorConnectionEpoch: envelope.executorConnectionEpoch }),
  hostId: envelope.hostId,
  organizationId: envelope.organizationId,
  protocolVersion: envelope.protocolVersion,
  purpose: envelope.purpose,
  sentAt: envelope.sentAt,
  sequence: envelope.sequence,
})

/** Purpose is in both the signed core and its domain to block cross-route replay. */
export const canonicalLocalInferenceEnvelope = (envelope: LocalInferenceEnvelopeCore): string => (
  canonicalExecutorPayload(
    `nessie.local-inference.${envelope.purpose}.v${envelope.protocolVersion}`,
    signedCore(envelope),
  )
)

export const digestCanonicalLocalInferenceBody = (body: unknown): string => (
  `sha256:${createHash('sha256').update(canonicalExecutorJson(body)).digest('hex')}`
)

const privateMachineKey = (encoded: string) => createPrivateKey({
  format: 'der',
  key: Buffer.from(encoded, 'base64url'),
  type: 'pkcs8',
})

const publicMachineKey = (encoded: string) => {
  // Desktop enrollment stores the public key in the representation the native
  // keychain bridge produced (normally PEM). Executor pairing uses a compact
  // raw/DER value. Both are the same Ed25519 identity; accepting neither a URL
  // nor an algorithm selector keeps this parser a key decoder, not a generic
  // crypto endpoint.
  if (encoded.includes('BEGIN PUBLIC KEY')) return createPublicKey(encoded)
  const decoded = Buffer.from(encoded, 'base64url')
  return createPublicKey({
    format: 'der',
    key: decoded.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, decoded]) : decoded,
    type: 'spki',
  })
}

export const signLocalInferenceEnvelope = (input: {
  body: unknown
  header: Omit<LocalInferenceEnvelopeCoreInput, 'bodyDigest'>
  machinePrivateKey: string
}): LocalInferenceSignedEnvelope => {
  const core = LocalInferenceEnvelopeCoreSchema.parse({
    ...input.header,
    bodyDigest: digestCanonicalLocalInferenceBody(input.body),
  })
  return LocalInferenceSignedEnvelopeSchema.parse({
    ...core,
    signature: sign(
      null,
      Buffer.from(canonicalLocalInferenceEnvelope(core)),
      privateMachineKey(input.machinePrivateKey),
    ).toString('base64url'),
  })
}

export type LocalInferenceEnvelopeVerification =
  | { ok: true; envelope: LocalInferenceSignedEnvelope }
  | {
    ok: false
    reason: 'body_digest_mismatch' | 'invalid_envelope' | 'invalid_machine_key' | 'invalid_signature'
  }

/**
 * Cryptographic validity only. API intake additionally persists purpose lanes,
 * checks connection epochs, and applies its server-clock freshness window.
 */
export const verifyLocalInferenceEnvelope = (input: {
  body: unknown
  envelope: unknown
  machinePublicKey: string
}): LocalInferenceEnvelopeVerification => {
  const parsed = LocalInferenceSignedEnvelopeSchema.safeParse(input.envelope)
  if (!parsed.success) return { ok: false, reason: 'invalid_envelope' }
  let bodyDigest: string
  try {
    bodyDigest = digestCanonicalLocalInferenceBody(input.body)
  } catch {
    return { ok: false, reason: 'body_digest_mismatch' }
  }
  if (bodyDigest !== parsed.data.bodyDigest) return { ok: false, reason: 'body_digest_mismatch' }
  let machineKey: ReturnType<typeof createPublicKey>
  try {
    machineKey = publicMachineKey(input.machinePublicKey)
  } catch {
    return { ok: false, reason: 'invalid_machine_key' }
  }
  try {
    return verify(
      null,
      Buffer.from(canonicalLocalInferenceEnvelope(parsed.data)),
      machineKey,
      Buffer.from(parsed.data.signature, 'base64url'),
    )
      ? { envelope: parsed.data, ok: true }
      : { ok: false, reason: 'invalid_signature' }
  } catch {
    return { ok: false, reason: 'invalid_signature' }
  }
}
