import { isAbsolute, join } from 'node:path'
import { unlink } from 'node:fs/promises'
import { loadExecutorState } from './state-store.js'
import {
  OPENAI_ENDPOINT_FILE, LocalOpenAiError, parseLocalOpenAiConfig,
  readLocalOpenAiConfig, saveLocalOpenAiConfig,
} from './openai-local-config.js'
import { observeLocalOpenAiModels } from './openai-local-observed.js'

const USAGE = 'Usage: nessie-executor local-inference endpoint configure|status|remove --state-dir <owner-only-path> [--config-stdin]'

/** Local command only: the hosted server never supplies an endpoint or its credentials. */
export const runLocalOpenAiCli = async (args: string[]): Promise<boolean> => {
  if (args[0] !== 'local-inference' || args[1] !== 'endpoint') return false
  const action = args[2]
  const stateDir = args[4]
  if (args[3] !== '--state-dir' || !stateDir || !isAbsolute(stateDir)
    || action === 'configure' && (args.length !== 6 || args[5] !== '--config-stdin')
    || action !== 'configure' && (args.length !== 5 || !['status', 'remove'].includes(action ?? ''))) {
    throw new Error(USAGE)
  }
  await loadExecutorState(stateDir)
  if (action === 'configure') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += bytes.byteLength
      if (size > 64 * 1024) throw new LocalOpenAiError('endpoint_configuration_invalid')
      chunks.push(bytes)
    }
    let input: unknown
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new LocalOpenAiError('endpoint_configuration_invalid') }
    await saveLocalOpenAiConfig(stateDir, parseLocalOpenAiConfig(input))
    process.stdout.write('Endpoint configuration saved. Restart this executor connection to apply it.\n')
  }
  if (action === 'remove') {
    await readLocalOpenAiConfig(stateDir)
    await unlink(join(stateDir, OPENAI_ENDPOINT_FILE)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    process.stdout.write('Endpoint configuration removed. Restart this executor connection to use Ollama.\n')
    return true
  }
  const config = await readLocalOpenAiConfig(stateDir)
  if (!config) {
    process.stdout.write(`${JSON.stringify({ backend: 'ollama', status: 'unconfigured' })}\n`)
    return true
  }
  try {
    const models = await observeLocalOpenAiModels(config)
    process.stdout.write(`${JSON.stringify({ backend: 'openai', status: 'online', models })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ backend: 'openai', status: 'offline', models: [] })}\n`)
  }
  return true
}
