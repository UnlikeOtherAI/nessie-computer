import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import type { LocalInferenceAttemptRequest, LocalInferenceResult } from '@nessie/executor-protocol'

import type { LocalInferenceHostTransport } from '../src/local-inference-api.js'
import { LocalInferenceHostLoop } from '../src/local-inference-host.js'
import { LocalInferenceCoordinator } from '../src/local-inference-coordinator.js'
import { EncryptedLocalInferenceReceiptJournal } from '../src/local-inference-receipts.js'
import { discoverOllamaInventory, isStructurallyLocalOllamaModel } from '../src/ollama-observed.js'

const hostId = '00000000-0000-4000-8000-0000000000e1'
const organizationId = '00000000-0000-4000-8000-0000000000e2'
const attemptId = '00000000-0000-4000-8000-0000000000e3'
const runId = '00000000-0000-4000-8000-0000000000e4'
const coordinator = await LocalInferenceCoordinator.open()
const resource = await coordinator.control()
assert.ok(resource.resourceId, 'Enroll a local inference resource before the product-host smoke.')
const admission = { admissionId: crypto.randomUUID(), fence: crypto.randomUUID(), resourceId: resource.resourceId }

const inventory = await discoverOllamaInventory()
const selected = inventory.models
  .filter((model) => isStructurallyLocalOllamaModel(model) && model.capabilities.includes('completion'))
  .sort((left, right) => (left.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (right.sizeBytes ?? Number.MAX_SAFE_INTEGER))[0]

assert.ok(selected, 'Ollama has no structurally local text model available for the live smoke.')

const keys = crypto.generateKeyPairSync('ed25519')
const machinePrivateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
const attempt: LocalInferenceAttemptRequest = {
  attemptId,
  bindingId: '00000000-0000-4000-8000-0000000000e5',
  bindingRevision: 1,
  deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  hostEpoch: 1,
  hostId,
  invocationId: 'local-ollama-live-smoke',
  maxOutputTokens: 24,
  messages: [{ content: 'Reply with exactly NESSIE_LOCAL_OK.', role: 'user' }],
  modelDigest: selected.manifestDigest,
  modelName: selected.name,
  numCtx: Math.min(selected.numCtxCap ?? 2_048, 2_048),
  protocolVersion: 1,
  runFence: 'local-ollama-live-smoke',
  runId,
  tools: [],
}

let offered = false
let heartbeatModels = 0
let result: LocalInferenceResult | undefined
const streamed: string[] = []
const hostErrors: string[] = []
const transport: LocalInferenceHostTransport = {
  attachResource: async () => ({
    ...resource, resourceId: admission.resourceId, healthReason: await coordinator.healthReason(),
  }),
  accept: async () => ({ state: 'active' }),
  claim: async () => {
    if (offered) return { admission: null, attempt: null, dispatchFence: null }
    offered = true
    return { admission, attempt, dispatchFence: 1 }
  },
  frame: (frame) => {
    const event = JSON.parse(Buffer.from(frame.data, 'base64url').toString('utf8')) as {
      text?: unknown
      type?: unknown
    }
    if (event.type === 'response.error') {
      const message = event as { message?: unknown }
      hostErrors.push(typeof message.message === 'string' ? message.message : 'unknown_host_error')
    } else {
      assert.equal(event.type, 'output_text.delta')
      assert.equal(typeof event.text, 'string')
      streamed.push(event.text as string)
    }
  },
  heartbeat: async (heartbeat) => {
    heartbeatModels = heartbeat.inventory.length
    return { serverTime: new Date().toISOString() }
  },
  result: async (receipt) => {
    result = receipt.result
    return { acknowledged: true }
  },
  terminate: async () => ({ acknowledged: true }),
}

let protectedReceipt: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
const journal = new EncryptedLocalInferenceReceiptJournal({
  read: async () => protectedReceipt,
  remove: async () => { protectedReceipt = undefined },
  write: async (value) => { protectedReceipt = value },
}, crypto.randomBytes(32))
const loop = new LocalInferenceHostLoop({
  transport,
  coordinator,
  identity: { connectionEpoch: '1', hostId, machinePrivateKey, organizationId },
  isPaused: () => false,
  journal,
  origin: inventory.origin,
})

await loop.heartbeat()
const outcome = await loop.pollOnce()
loop.stop()

assert.deepEqual(outcome, { attemptId, kind: 'completed' })
assert.ok(heartbeatModels > 0, 'The product host heartbeat published no detected local models.')
assert.ok(
  result,
  `The product host loop did not submit a terminal receipt (${JSON.stringify({
    hostErrors,
    protectedReceipt: protectedReceipt !== undefined,
    streamedBytes: streamed.join('').length,
  })}).`,
)
assert.notEqual(result.finishReason, 'error', `The product host reported: ${hostErrors.join(', ') || 'unknown error'}`)
assert.equal(result.remoteHost, null)
assert.equal(result.remoteModel, null)
assert.equal(result.modelDigest, selected.manifestDigest)
assert.equal(streamed.join(''), result.content ?? '')
assert.ok((result.content ?? '').trim().length > 0, 'The installed local model returned no text.')

process.stdout.write(JSON.stringify({
  finishReason: result.finishReason,
  model: selected.name,
  observedModels: heartbeatModels,
  outputMatchedStream: true,
  transport: 'nessie-local-inference-host-loop',
}) + '\n')
