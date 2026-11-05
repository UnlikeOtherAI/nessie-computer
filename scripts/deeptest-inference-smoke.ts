/** Owner-invoked local-model proof. Never selects a paid CLI or remote provider. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { saveExecutorState } from '../src/state-store.js'
import type { DeepTestInferenceModel, DeepTestInferenceResponse } from '../src/deeptest-inference-protocol.js'

const args = process.argv.slice(2)
if (args.length !== 3 || args[0] !== '--model' || args[2] !== '--confirm-local-inference'
  || !args[1] || args[1].length > 200) {
  throw new Error('Usage: deeptest-inference-smoke.ts --model <installed Ollama model> --confirm-local-inference')
}
const modelName = args[1]
const directory = await mkdtemp(join(tmpdir(), 'nessie-deeptest-native-smoke-'))
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const cliArgs = ['--import', 'tsx', entry]
const exec = promisify(execFile)
let child: ReturnType<typeof spawn> | undefined
try {
  await saveExecutorState(directory, {
    apiBaseUrl: 'https://api.deeptest.invalid', executorId: randomUUID(),
    machinePrivateKey: 'synthetic-unused-key', machinePublicKey: 'synthetic-unused-key',
    workspaceFolders: [{ name: 'fixture', path: directory }],
    descriptor: { limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 65536, maxSessions: 1 },
      operationKeys: [], profiles: [], revision: 1 },
  })
  const published = await exec(process.execPath, [...cliArgs, 'publish-deeptest-inference-grant',
    '--state-dir', directory, '--engines', 'ollama', '--confirm-inference'], { env: process.env })
  const path = published.stdout.trim()
  assert.equal(path, join(directory, 'deeptest-inference-grant.json'))
  child = spawn(process.execPath, [...cliArgs, 'deeptest-inference', '--inference-grant-file', path], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const waiting = new Map<string, { resolve: (response: DeepTestInferenceResponse) => void; reject: (error: Error) => void }>()
  const reader = createInterface({ input: child.stdout! })
  reader.on('line', (line) => {
    const response = JSON.parse(line) as DeepTestInferenceResponse
    waiting.get(response.request_id)?.resolve(response)
    waiting.delete(response.request_id)
  })
  child.stderr?.resume()
  const stopped = new Promise<void>((resolve) => child!.once('close', () => {
    for (const request of waiting.values()) request.reject(new Error('Native inference smoke child exited.'))
    resolve()
  }))
  let ordinal = 0
  const post = async (operation: string, fields: Record<string, unknown> = {}) => {
    const request_id = `smoke_${++ordinal}`
    const answer = new Promise<DeepTestInferenceResponse>((resolve, reject) => {
      waiting.set(request_id, { resolve, reject })
      // This is the bounded smoke harness only, never an assessment quota.
      const timer = setTimeout(() => reject(new Error('Native inference smoke did not complete.')), 180000)
      timer.unref()
      void stopped.then(() => clearTimeout(timer))
    })
    child!.stdin!.write(`${JSON.stringify({ protocol_version: 1, request_id, operation,
      account_id: 'smoke.account', project_id: 'smoke.project', review_id: 'smoke.review', session_id: 'smoke.session',
      ...fields })}\n`)
    const response = await answer
    if (response.status !== 'ok') throw new Error(response.error.code)
    return response.result
  }
  await post('hello')
  const inventory = await post('inference.models')
  const model = (inventory.models as DeepTestInferenceModel[]).find((candidate) => candidate.engine === 'ollama'
    && candidate.label === modelName)
  assert.ok(model, 'The requested local model must be in the live native catalog.')
  const answer = await post('inference.chat', {
    model_id: model.id, model_digest: model.model_digest, context_length: 4096, max_output_tokens: 64,
    messages: [{ role: 'user', content: 'Return exactly DEEPTEST_LOCAL_INFERENCE_OK and nothing else.' }], tools: [],
  })
  assert.equal(String(answer.content).trim(), 'DEEPTEST_LOCAL_INFERENCE_OK')
  process.stdout.write(`${JSON.stringify({ model: model.label, model_digest: model.model_digest,
    engine: model.engine, reply_matches: true, usage: answer.usage, finish_reason: answer.finish_reason })}\n`)
  child.stdin!.end()
  await stopped
  await exec(process.execPath, [...cliArgs, 'revoke-deeptest-inference-grant', '--state-dir', directory], { env: process.env })
} finally {
  if (child && child.exitCode === null) {
    child.stdin?.destroy()
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child!.once('close', () => resolve()))
  }
  await rm(directory, { recursive: true, force: true })
}
