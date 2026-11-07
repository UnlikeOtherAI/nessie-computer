import { safeFetch } from '@nessie/executor-support/url-safety'
import { fetch as localFetch, type RequestInit as LocalRequestInit } from 'undici'

/** Fixed provider endpoints use this bounded transport; no body or credential is logged. */
export const quotaFetch: typeof fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : input.toString())
  const request = { ...options, redirect: 'error' as const,
    signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(options.signal ? [options.signal] : [])]) }
  if (url.username || url.password || url.hash || url.search) throw new Error('Quota endpoint is not supported.')
  const sysmon = url.origin === 'http://127.0.0.1:7738' && url.pathname === '/mcp'
  if (!sysmon && url.href !== 'https://api.kimi.com/coding/v1/usages') {
    throw new Error('Quota endpoint is not supported.')
  }
  // This authenticated MCP service is deliberately local. The literal IP has no DNS rebinding path.
  const response = sysmon ? await localFetch(url, request as LocalRequestInit) as unknown as Response
    : await safeFetch(url, request, { credentialsPresent: true, maxRedirects: 0 })
  let bytes = 0
  const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length
      if (bytes > 256 * 1024) throw new Error('Quota response exceeds its limit.')
      controller.enqueue(chunk)
    },
  }))
  return new Response(body ?? null, { status: response.status, statusText: response.statusText,
    headers: response.headers })
}
