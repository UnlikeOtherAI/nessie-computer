import {
  createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
  type KeyObject,
} from 'node:crypto'

/**
 * How what an owner types in secret reaches the session host without being
 * written down readable on the way: a supplied secret's value (which the host
 * needs only to keep it out of every later event) and the values of a
 * question marked `secret`.
 *
 * Each host makes an X25519 key pair when it starts and keeps the private key
 * in memory alone; `requests.json` carries the public key. The bridge seals
 * those values to it for the one request they answer (X25519, HKDF-SHA-256,
 * AES-256-GCM with the request id as additional data), so the inbox, the
 * delivery record and anything a crash leaves behind hold only a sealed box
 * that no later process can open — a host that restarts has a new key, and
 * the requests it could have answered expired with its provider.
 */

export type SealedAnswer = { epk: string; iv: string; data: string; tag: string }

/** What is sealed: a secret's value, and the answers to questions marked secret. */
export type SealedContent = { secret?: string; answers?: { questionId: string; values: string[] }[] }

const INFO = Buffer.from('nessie.session-answer.v1')

const keyFor = (shared: Buffer, epk: Buffer, recipient: Buffer): Buffer => Buffer.from(
  hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), INFO, 32),
)

const spki = (key: KeyObject): Buffer => key.export({ type: 'spki', format: 'der' })

export type AnswerKey = {
  /** The public half, as `requests.json` carries it. */
  publicKey: string
  /** The content sealed for this request, or undefined when it was sealed for another key or another request. */
  open: (sealed: unknown, requestId: string) => SealedContent | undefined
}

export const createAnswerKey = (): AnswerKey => {
  const pair = generateKeyPairSync('x25519')
  const recipient = spki(pair.publicKey)
  return {
    publicKey: recipient.toString('base64'),
    open: (sealed, requestId) => {
      try {
        const box = sealed as SealedAnswer
        const epk = Buffer.from(box.epk, 'base64')
        const shared = diffieHellman({
          privateKey: pair.privateKey, publicKey: createPublicKey({ key: epk, format: 'der', type: 'spki' }),
        })
        const decipher = createDecipheriv('aes-256-gcm', keyFor(shared, epk, recipient), Buffer.from(box.iv, 'base64'))
        decipher.setAAD(Buffer.from(requestId))
        decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
        const text = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8')
        const content = JSON.parse(text) as SealedContent
        return content && typeof content === 'object' ? content : undefined
      } catch {
        return undefined
      }
    },
  }
}

/** Seals `content` to a host's public key, for one request. */
export const sealAnswer = (publicKey: string, requestId: string, content: SealedContent): SealedAnswer => {
  const recipient = Buffer.from(publicKey, 'base64')
  const ephemeral = generateKeyPairSync('x25519')
  const epk = spki(ephemeral.publicKey)
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: recipient, format: 'der', type: 'spki' }),
  })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(shared, epk, recipient), iv)
  cipher.setAAD(Buffer.from(requestId))
  const data = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()])
  return { epk: epk.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64') }
}
