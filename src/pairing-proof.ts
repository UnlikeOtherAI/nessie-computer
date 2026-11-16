import { createPrivateKey, sign } from 'node:crypto'
import { canonicalExecutorPayload } from '@nessie/executor-protocol'

export const pairingSignature = (key: string, action: string, payload: Record<string, unknown>): string => sign(
  null,
  Buffer.from(canonicalExecutorPayload(`nessie.executor.pairing.${action}.v1`, payload)),
  createPrivateKey({ key: Buffer.from(key, 'base64url'), format: 'der', type: 'pkcs8' }),
).toString('base64url')

