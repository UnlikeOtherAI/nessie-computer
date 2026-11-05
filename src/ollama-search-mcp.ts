import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const MAX_RESPONSE_BYTES = 48 * 1024
const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)
const validResult = (name: string, value: unknown): boolean => {
  if (!record(value)) return false
  if (name === 'ollama_web_search') {
    return Array.isArray(value.results) && value.results.every((entry: unknown) => record(entry)
      && typeof entry.title === 'string' && typeof entry.content === 'string' && typeof entry.url === 'string')
  }
  return typeof value.title === 'string' && typeof value.content === 'string'
    && Array.isArray(value.links) && value.links.every((link: unknown) => typeof link === 'string')
}
const tools = [
  {
    name: 'ollama_web_search', description: 'Search using this executor’s configured Ollama account. Returns source URLs and excerpts.',
    inputSchema: {
      type: 'object' as const, additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 4_000 }, max_results: { type: 'integer', minimum: 1, maximum: 10 } },
    },
  },
  {
    name: 'ollama_web_fetch', description: 'Read a public page using this executor’s configured Ollama account.',
    inputSchema: {
      type: 'object' as const, additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string', minLength: 1, maxLength: 4_000 } },
    },
  },
]

export class OllamaSearchError extends Error {
  override readonly name = 'OllamaSearchError'
  constructor(readonly code: string) { super(code) }
}

const inputBody = (name: string, args: Record<string, unknown>): { path: string; body: Record<string, unknown> } => {
  if (name === 'ollama_web_search') {
    if (Object.keys(args).some((key) => !['query', 'max_results'].includes(key))
      || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4_000
      || args.max_results !== undefined && (!Number.isInteger(args.max_results)
        || Number(args.max_results) < 1 || Number(args.max_results) > 10)) throw new OllamaSearchError('invalid_arguments')
    return { path: 'web_search', body: args }
  }
  if (name === 'ollama_web_fetch') {
    if (Object.keys(args).some((key) => key !== 'url') || typeof args.url !== 'string' || args.url.length > 4_000) {
      throw new OllamaSearchError('invalid_arguments')
    }
    let url: URL
    try { url = new URL(args.url) } catch { throw new OllamaSearchError('invalid_arguments') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new OllamaSearchError('invalid_arguments')
    // Ollama, not this local host, fetches the page. No model-chosen address is
    // ever dialled with the account credential; our only network peer is fixed.
    return { path: 'web_fetch', body: { url: url.toString() } }
  }
  throw new OllamaSearchError('unsupported_tool')
}

/** Fixed account API, no inference routing and no Ledger fallback. */
export const callOllamaSearch = async (input: {
  apiKey: string | undefined
  args: Record<string, unknown>
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  name: string
}): Promise<unknown> => {
  if (!input.apiKey?.trim()) throw new OllamaSearchError('search_credentials_missing')
  const request = inputBody(input.name, input.args)
  let response: Response
  try {
    // eslint-disable-next-line no-restricted-globals -- fixed HTTPS peer; redirects cannot carry the credential
    response = await (input.fetchImpl ?? fetch)(`https://ollama.com/api/${request.path}`, {
      method: 'POST', body: JSON.stringify(request.body), redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    })
  } catch { throw new OllamaSearchError('search_unavailable') }
  if (response.status === 401 || response.status === 403) throw new OllamaSearchError('search_credentials_rejected')
  if (response.status === 429) throw new OllamaSearchError('search_quota_exhausted')
  if (!response.ok) throw new OllamaSearchError('search_unavailable')
  if (!response.body) throw new OllamaSearchError('search_invalid_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new OllamaSearchError('search_result_too_large')
      }
      chunks.push(next.value)
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!validResult(input.name, result)) throw new Error('shape')
    return result
  } catch (error) {
    if (error instanceof OllamaSearchError) throw error
    throw new OllamaSearchError('search_invalid_response')
  }
}

export const serveOllamaSearchMcp = async (): Promise<void> => {
  const server = new Server({ name: 'nessie-ollama-search', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callOllamaSearch({
        apiKey: process.env.OLLAMA_API_KEY, args: request.params.arguments ?? {}, name: request.params.name,
      })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      const code = error instanceof OllamaSearchError ? error.code : 'search_unavailable'
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] }
    }
  })
  await server.connect(new StdioServerTransport())
}
