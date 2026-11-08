import { LocalInferenceApiError, localInferenceTransportCode } from './local-inference-api.js'
import { LocalInferenceReceiptError } from './local-inference-receipts.js'
import { OllamaChatError } from './ollama-chat.js'
import { LocalOpenAiError } from './openai-local-config.js'
import { ChatgptError } from './chatgpt-errors.js'
import { LocalCliEngineError } from './local-cli-engine-error.js'

const API_CODES = new Set([
  'LOCAL_INFERENCE_API_CANCELLED', 'LOCAL_INFERENCE_API_TIMEOUT', 'LOCAL_INFERENCE_API_UNREACHABLE',
  'LOCAL_INFERENCE_API_INVALID', 'LOCAL_INFERENCE_API_FAILED', 'LOCAL_ATTEMPT_FENCED', 'LOCAL_HOST_UNAVAILABLE',
])

export type LocalInferenceFailure = {
  category: 'endpoint' | 'ollama' | 'relay' | 'receipt' | 'host' | 'chatgpt' | 'cli'
  code: string
  apiCode?: string
  status?: number
  transportCode?: string
}

/** Closed diagnostic fields only: no provider text, private URLs, keys or exception messages. */
export const localInferenceFailure = (error: unknown): LocalInferenceFailure => {
  if (error instanceof ChatgptError) return { category: 'chatgpt', code: error.code,
    ...(error.status ? { status: error.status } : {}) }
  if (error instanceof LocalOpenAiError) return { category: 'endpoint', code: error.code }
  if (error instanceof LocalCliEngineError) return { category: 'cli', code: error.code }
  if (error instanceof OllamaChatError) return { category: 'ollama', code: error.code }
  if (error instanceof LocalInferenceApiError) {
    const transportCode = localInferenceTransportCode({ code: error.transportCode })
    return {
      category: 'relay',
      code: error.code === 'LOCAL_INFERENCE_API_CANCELLED' ? 'cancelled' : 'local_inference_delivery_failed',
      ...(API_CODES.has(error.code) ? { apiCode: error.code } : {}),
      ...(error.status && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? { status: error.status } : {}),
      ...(transportCode ? { transportCode } : {}),
    }
  }
  if (error instanceof LocalInferenceReceiptError) return { category: 'receipt', code: 'local_inference_receipt_failed' }
  return { category: 'host', code: 'local_inference_host_failed' }
}
