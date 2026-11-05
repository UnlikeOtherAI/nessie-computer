import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { ExecutorInferenceSourceSchema, type ExecutorInferenceSource } from '@nessie/executor-protocol'

/** A resource key proves shared local custody; it grants no model or source access. */
export type LocalInferenceResourceAttachment = {
  inferenceSource?: ExecutorInferenceSource
  connectionEpoch: string
  hostId: string
  organizationId: string
  publicKey: string
}

const attachmentBytes = (input: LocalInferenceResourceAttachment): Buffer => {
  const source = input.inferenceSource === undefined ? undefined
    : ExecutorInferenceSourceSchema.parse(input.inferenceSource)
  const identity = [input.connectionEpoch, input.hostId, input.organizationId, input.publicKey]
  // Existing Desktop/default local proofs retain their byte contract. Cloud
  // attachment cannot reuse a physical proof or change any profile fence.
  return Buffer.from(JSON.stringify(source?.kind === 'chatgpt'
    ? ['nessie.chatgpt.resource.v1', ...identity, source.kind, source.processing, source.billingSource,
      source.profileId, source.accountGeneration, source.consentRevision]
    : ['nessie.local-inference.resource.v1', ...identity]))
}

export const signLocalInferenceResourceAttachment = (
  input: LocalInferenceResourceAttachment,
  privateKey: string,
): string => sign(null, attachmentBytes(input), createPrivateKey({
  key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8',
})).toString('base64url')

export const verifyLocalInferenceResourceAttachment = (
  input: LocalInferenceResourceAttachment & { signature: string },
): string | null => {
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return null
    if (!verify(null, attachmentBytes(input), key, Buffer.from(input.signature, 'base64url'))) return null
    return createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex')
  } catch {
    return null
  }
}
