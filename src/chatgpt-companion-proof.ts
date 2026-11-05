import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { canonicalExecutorPayload } from '@nessie/executor-protocol'
import { PersonalInferenceProtectionError } from './personal-inference-paths.js'

export type ChatgptCompanionKey = { publicKey: string; privateKey: string }
export const chatgptCompanionFingerprint = (key: ChatgptCompanionKey): string => {
  const bytes = Buffer.from(key.publicKey, 'base64url')
  const publicKey = createPublicKey({ format: 'der', type: 'spki', key: bytes })
  const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(key.privateKey, 'base64url') })
  if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519'
    || publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') !== key.publicKey
    || createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url') !== key.publicKey) {
    throw new PersonalInferenceProtectionError('chatgpt_owner_authority_unavailable')
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
export const signChatgptCompanionProof = (key: ChatgptCompanionKey, proof: { challengeId: string; digest: string }):
string => {
  chatgptCompanionFingerprint(key)
  return sign(null, Buffer.from(canonicalExecutorPayload('nessie.executor.personal-host.prove.v1', proof)),
    createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(key.privateKey, 'base64url') }))
    .toString('base64url')
}
