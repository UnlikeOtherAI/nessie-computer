import { verifyInferenceTestState } from './local-inference-security.js'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LocalInferenceAttemptRequest, LocalInferenceResult } from '@nessie/executor-protocol'

import { LocalInferenceCoordinator } from '../../src/local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from '../../src/local-inference-receipts.js'
import type { LocalInferenceHostTransport } from '../../src/local-inference-api.js'
import type { OllamaFetch } from '../../src/ollama-client.js'

export const HOST_ID = '11111111-1111-4111-8111-111111111111'
export const ORG_ID = '22222222-2222-4222-8222-222222222222'
export const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
export const BINDING_ID = '44444444-4444-4444-8444-444444444444'
export const RUN_ID = '55555555-5555-4555-8555-555555555555'
export const DIGEST = 'a'.repeat(64)
export const RESOURCE_ID = '66666666-6666-4666-8666-666666666666'
export const ADMISSION = { admissionId: '77777777-7777-4777-8777-777777777777', fence: '88888888-8888-4888-8888-888888888888', resourceId: RESOURCE_ID }

export const coordinatorFixture = async (t: import('node:test').TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'nessie-host-coordinator-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return LocalInferenceCoordinator.open({ directory, security: process.platform === 'win32' ? { helper: verifyInferenceTestState } : {} })
}

export const machineKeys = (): { privateKey: string; publicKey: string } => {
  const keys = generateKeyPairSync('ed25519')
  return {
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

export const attempt = (): LocalInferenceAttemptRequest => ({
  attemptId: ATTEMPT_ID,
  bindingId: BINDING_ID,
  bindingRevision: 1,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  hostEpoch: 1,
  hostId: HOST_ID,
  invocationId: 'invocation-1',
  maxOutputTokens: 64,
  messages: [{ content: 'Say hello', role: 'user' }],
  modelDigest: DIGEST,
  modelName: 'local:latest',
  numCtx: 8192,
  protocolVersion: 1,
  runFence: 'run-fence-1',
  runId: RUN_ID,
  tools: [],
})

export const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

export const ollama = (chatLines: unknown[], contextLength: number | null = 8192): OllamaFetch => (url) => {
  if (url.endsWith('/api/version')) return Promise.resolve(json({ version: '0.34.1' }))
  if (url.endsWith('/api/tags')) {
    return Promise.resolve(json({ models: [{ digest: DIGEST, name: 'local:latest', size: 7 }] }))
  }
  if (url.endsWith('/api/show')) {
    return Promise.resolve(json({
      capabilities: ['completion', 'tools'],
      details: { family: 'gemma' },
      model_info: contextLength === null ? {} : { 'general.context_length': contextLength },
    }))
  }
  if (url.endsWith('/api/chat')) {
    return Promise.resolve(new Response(`${chatLines.map((line) => JSON.stringify(line)).join('\n')}\n`))
  }
  throw new Error(`Unexpected local call ${url}`)
}

export const localResult = (): LocalInferenceResult => ({
  capability: {
    discoveredAt: new Date().toISOString(),
    model: 'local:latest',
    provider: 'local_device',
    source: 'live',
    structuredOutputMode: 'text-only',
    supportsChat: true,
    supportsEmbeddings: false,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsVision: false,
    systemPromptMode: 'native',
    toolCallingMode: 'disabled',
    toolResultMode: 'native-tool-message',
    usageReporting: {
      cachedInputTokens: false,
      cachedOutputTokens: false,
      cacheReadTokens: false,
      cacheWriteTokens: false,
      inputTokens: true,
      outputTokens: true,
      providerReportedCost: false,
    },
  },
  content: 'saved result',
  finishReason: 'stop',
  modelDigest: DIGEST,
  remoteHost: null,
  remoteModel: null,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

export const receiptJournal = () => {
  let stored: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  const journal = new EncryptedLocalInferenceReceiptJournal({
    read: async () => stored,
    remove: async () => { stored = undefined },
    write: async (value) => { stored = value },
  }, new Uint8Array(32).fill(7))
  return { getStored: () => stored, journal }
}

export type ApiCalls = {
  frames: Array<{ frame: Parameters<LocalInferenceHostTransport['frame']>[0] }>
  heartbeats: Array<{ heartbeat: { inventory: unknown[]; paused: boolean } }>
  results: Array<{ receipt: { result: LocalInferenceResult } }>
  accepts: Array<{ attemptId: string; dispatchFence: number }>
}

/** A fake socket transport: records what the host sent, answers like Nessie would. */
export const apiFor = (
  lease: LocalInferenceAttemptRequest | null,
  dispatchFence = 1,
): { api: LocalInferenceHostTransport; calls: ApiCalls } => {
  const calls: ApiCalls = { accepts: [], frames: [], heartbeats: [], results: [] }
  return {
    api: {
      attachResource: async () => ({
        capacity: 1, controlRevision: 1, paused: false, resourceId: RESOURCE_ID, healthReason: null,
      }),
      accept: async (control) => { calls.accepts.push(control); return { state: 'active' } },
      claim: async () => lease === null
        ? { admission: null, attempt: null, dispatchFence: null }
        : { admission: ADMISSION, attempt: lease, dispatchFence },
      frame: (frame) => { calls.frames.push({ frame }) },
      heartbeat: async (heartbeat) => {
        calls.heartbeats.push({ heartbeat })
        return { serverTime: new Date().toISOString() }
      },
      result: async (receipt) => {
        calls.results.push({ receipt })
        return { acknowledged: true }
      },
      terminate: async () => ({ acknowledged: true }),
    },
    calls,
  }
}
