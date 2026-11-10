import { safeFetch } from '@nessie/executor-support/url-safety'
import { ChatgptError } from './chatgpt-errors.js'
import type { ChatgptAccessLease } from './chatgpt-auth-provider.js'

export type ChatgptFetch = (url: string, init: RequestInit) => Promise<Response>
export const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models'
export const CHATGPT_RESPONSES_URL = 'https://api.openai.com/v1/responses'
export const CHATGPT_PERSONAL_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
export const CHATGPT_PERSONAL_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

export const chatgptHeaders = (lease: ChatgptAccessLease): Record<string, string> => ({
  Authorization: `Bearer ${lease.accessToken}`,
  ...(lease.accountId ? { 'ChatGPT-Account-Id': lease.accountId, originator: 'nessie-computer' } : {}),
})

/** Code-owned HTTPS origins only; no redirects or credentials from server config. */
export const chatgptFetch: ChatgptFetch = (url, init) => {
  const endpoints = [CHATGPT_MODELS_URL, CHATGPT_RESPONSES_URL,
    CHATGPT_PERSONAL_MODELS_URL, CHATGPT_PERSONAL_RESPONSES_URL]
  if (!endpoints.includes(url)) {
    throw new ChatgptError('chatgpt_policy_denied', 'not_sent')
  }
  return safeFetch(url, { ...init, redirect: 'error' }, { credentialsPresent: true, maxRedirects: 0 })
}

export const readChatgptJson = async (response: Response): Promise<unknown> => {
  const maximum = 1024 * 1024
  if (!response.body) throw new ChatgptError('chatgpt_protocol_error', 'unknown')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new ChatgptError('chatgpt_protocol_error', 'unknown')
      chunks.push(next.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } catch {
    throw new ChatgptError('chatgpt_protocol_error', 'unknown')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
