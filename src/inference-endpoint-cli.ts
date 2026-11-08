import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { loadExecutorState } from './state-store.js'
import { changeInferenceEndpoint, defaultInferenceEndpoint, readInferenceEndpoints } from './inference-endpoints.js'
import { createLocalModelServerBackend } from './local-model-server.js'
import { parseLocalOpenAiConfig } from './openai-local-config.js'

export const InferenceEndpointOperation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status') }).strict(),
  z.object({ operation: z.literal('save'), id: z.string().uuid(), name: z.string().trim().min(1).max(80),
    baseUrl: z.string().min(1).max(512), scope: z.enum(['local', 'network']),
    apiKey: z.string().max(4096).refine(value => !/[\r\n]/.test(value)).optional(),
  }).strict(),
  z.object({ operation: z.literal('remove'), id: z.string().uuid() }).strict(),
])

/** Public native projection: endpoint secrets never make a round trip into a WebView. */
export const inferenceEndpointStatus = async (directory: string) => {
  const endpoints = await readInferenceEndpoints(directory) ?? [defaultInferenceEndpoint()]
  return { endpoints: await Promise.all(endpoints.map(async endpoint => {
    const { config } = endpoint
    const backend = createLocalModelServerBackend(async () => config)
    const summary = { id: endpoint.id, name: endpoint.name, baseUrl: config.baseUrl,
      scope: config.networkServiceConfirmed ? 'network' : 'local', hasApiKey: Boolean(config.apiKey) }
    try {
      const models = await backend.observe()
      return { ...summary, status: 'online', models: models.map(model => model.displayName ?? model.name) }
    } catch { return { ...summary, status: 'offline', models: [] } }
  })) }
}
export const applyInferenceEndpointOperation = async (directory: string, input: unknown): Promise<void> => {
  const action = InferenceEndpointOperation.parse(input)
  if (action.operation === 'status') return
  if (action.operation === 'remove') { await changeInferenceEndpoint(directory, action); return }
  const apiKey = action.apiKey
  const config = parseLocalOpenAiConfig({ baseUrl: action.baseUrl, ...(apiKey ? { apiKey } : {}),
    ...(action.scope === 'network' ? { networkServiceConfirmed: true } : { localServiceConfirmed: true }) })
  await changeInferenceEndpoint(directory, { operation: 'save', id: action.id, name: action.name, config,
    preserveApiKey: action.apiKey === undefined })
}
export const runInferenceEndpointsCli = async (args: string[]): Promise<boolean> => {
  if (args[0] !== 'local-inference' || args[1] !== 'connections') return false
  const directory = args[4]
  if (args.length !== 5 || !['status', '--operation-stdin'].includes(args[2] ?? '')
    || args[3] !== '--state-dir' || !directory || !isAbsolute(directory)) throw new Error('Invalid inference connection command.')
  await loadExecutorState(directory)
  if (args[2] === '--operation-stdin') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array)
      size += bytes.length
      if (size > 16 * 1024) throw new Error('endpoint_configuration_invalid')
      chunks.push(bytes)
    }
    await applyInferenceEndpointOperation(directory, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
  }
  process.stdout.write(`${JSON.stringify(await inferenceEndpointStatus(directory))}\n`)
  return true
}
