import assert from 'node:assert/strict'
import test from 'node:test'
import { callOllamaSearch } from '../src/ollama-search-mcp.js'

test('Ollama research uses only the configured account and the fixed provider endpoint', async () => {
  const calls: string[] = []
  const result = await callOllamaSearch({
    apiKey: 'host-only-fixture', args: { query: '研究する', max_results: 2 }, name: 'ollama_web_search',
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer host-only-fixture')
      assert.deepEqual(JSON.parse(String(init?.body)), { query: '研究する', max_results: 2 })
      return new Response(JSON.stringify({ results: [] }))
    },
  })
  assert.deepEqual(result, { results: [] })
  assert.deepEqual(calls, ['https://ollama.com/api/web_search'])
})

test('credentials and quota failures have distinct remedies and never invoke a fallback', async () => {
  let calls = 0
  const input = { args: { query: 'test' }, name: 'ollama_web_search', fetchImpl: async () => { calls += 1; return new Response('', { status: 429 }) } }
  await assert.rejects(callOllamaSearch({ ...input, apiKey: undefined }), /search_credentials_missing/)
  assert.equal(calls, 0)
  await assert.rejects(callOllamaSearch({ ...input, apiKey: 'fixture' }), /search_quota_exhausted/)
  assert.equal(calls, 1)
  await assert.rejects(callOllamaSearch({ ...input, apiKey: 'fixture', fetchImpl: async () => new Response('', { status: 401 }) }), /search_credentials_rejected/)
})

test('tool names, extra arguments, URL credentials and oversized bodies fail closed', async () => {
  const input = { apiKey: 'fixture', args: { query: 'test' }, name: 'ollama_web_search', fetchImpl: async () => new Response('x'.repeat(50 * 1024)) }
  await assert.rejects(callOllamaSearch(input), /search_result_too_large/)
  await assert.rejects(callOllamaSearch({ ...input, name: 'web_search' }), /unsupported_tool/)
  await assert.rejects(callOllamaSearch({ ...input, args: { query: 'test', url: 'http://127.0.0.1' } }), /invalid_arguments/)
  await assert.rejects(callOllamaSearch({ ...input, name: 'ollama_web_fetch', args: { url: 'https://secret@example.com' } }), /invalid_arguments/)
})
