import { createPrivateKey, sign } from 'node:crypto'

import { canonicalExecutorPayload } from '@nessie/executor-protocol'

export type ExecutorDaemonSignatureDomain =
  | 'session_view'
  | 'attachment'
  | 'browser_cookie_import.poll'
  | 'browser_cookie_import.upload'
  | 'claim'
  | 'cancel'
  | 'heartbeat'
  | 'imessage'
  | 'local_inference.host'
  | 'local_inference.cli_host'
  | 'chatgpt.challenge'
  | 'chatgpt.delegate'
  | 'chatgpt.disconnect'
  | 'poll'
  | 'receipt'
  | 'sync'
  | 'teams'

/** Signs a bounded executor control-plane request with the paired machine key. */
export const signExecutorDaemonPayload = (
  privateKeyDer: string,
  domain: ExecutorDaemonSignatureDomain,
  payload: Record<string, unknown>,
): string => sign(
  null,
  Buffer.from(canonicalExecutorPayload(`nessie.executor.daemon.${domain}.v1`, payload)),
  createPrivateKey({
    format: 'der',
    key: Buffer.from(privateKeyDer, 'base64url'),
    type: 'pkcs8',
  }),
).toString('base64url')
