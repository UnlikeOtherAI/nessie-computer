import { Readable, Writable } from 'node:stream'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { createDeepTestInferenceBackends, type DeepTestInferenceBackend } from './deeptest-inference-backend.js'
import { currentInferenceConfig, type DeepTestInferenceGrant } from './deeptest-inference-grant.js'
import { parseDeepTestInferenceRequest, type DeepTestInferenceResponse } from './deeptest-inference-protocol.js'

const MAX_FRAME = 1024 * 1024
const failure = (requestId: string, code: string): DeepTestInferenceResponse => ({
  protocol_version: 1, request_id: requestId, status: 'error',
  error: { code, message: 'Executor inference could not complete this request.', retryable: code === 'INFERENCE_UNAVAILABLE' },
})
const safeCodes = new Set(['REQUEST_INVALID', 'BINDING_MISMATCH', 'HELLO_REQUIRED', 'GRANT_REVOKED', 'CANCELLED',
  'MODEL_CHANGED', 'UNSUPPORTED_CAPABILITY', 'OUTPUT_BYTES_LIMIT', 'INFERENCE_INCOMPLETE', 'FRAME_TOO_LARGE'])

export const createDeepTestInferenceAdapter = (
  grant: DeepTestInferenceGrant,
  refresh: () => Promise<DeepTestInferenceGrant>,
  backends: Partial<Record<string, DeepTestInferenceBackend>>,
) => {
  let binding: string | undefined
  let closed = false
  let active: AbortController | undefined
  const seen = new Set<string>()
  const validGrant = async () => {
    try {
      if (closed || canonicalExecutorJson(await refresh()) !== canonicalExecutorJson(grant)) throw new Error('GRANT_REVOKED')
    } catch { throw new Error('GRANT_REVOKED') }
  }
  return {
    close: () => { closed = true; active?.abort(new Error('CANCELLED')) },
    dispatch: async (input: unknown): Promise<DeepTestInferenceResponse> => {
      const candidateId = (input as { request_id?: unknown } | null)?.request_id
      const requestId = typeof candidateId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(candidateId) ? candidateId : 'invalid'
      let timer: NodeJS.Timeout | undefined
      let invocation: AbortController | undefined
      try {
        const request = parseDeepTestInferenceRequest(input)
        await validGrant()
        const identity = canonicalExecutorJson({ account_id: request.account_id, project_id: request.project_id,
          review_id: request.review_id, session_id: request.session_id })
        if (binding !== undefined && identity !== binding) throw new Error('BINDING_MISMATCH')
        if (seen.has(requestId)) throw new Error('REQUEST_INVALID')
        if (binding === undefined && request.operation !== 'hello') throw new Error('HELLO_REQUIRED')
        seen.add(requestId)
        binding ??= identity
        const ok = (result: Record<string, unknown>): DeepTestInferenceResponse => ({ protocol_version: 1, request_id: requestId, status: 'ok', result })
        if (request.operation === 'hello') return ok({ protocol_version: 1, executor_id: grant.executorId,
          capabilities: ['inference.models', 'inference.chat'] })
        if (request.operation === 'inference.models') {
          const results = await Promise.allSettled(grant.engines.map((engine) => backends[engine]?.models() ?? []))
          await validGrant()
          const models = results.flatMap((value) => value.status === 'fulfilled' ? value.value : [])
          if (models.length > 400 || new Set(models.map((model) => model.id)).size !== models.length) throw new Error('INFERENCE_UNAVAILABLE')
          return ok({ models })
        }
        if (active) throw new Error('REQUEST_INVALID')
        const backend = backends[request.model_id.split(':')[0]!]
        if (!backend || !grant.engines.includes(request.model_id.split(':')[0] as typeof grant.engines[number])) throw new Error('MODEL_CHANGED')
        active = new AbortController()
        const controller = active
        invocation = controller
        let revocation = false
        let checking = false
        timer = setInterval(() => {
          if (checking) return
          checking = true
          void validGrant().catch(() => { revocation = true; controller.abort(new Error('GRANT_REVOKED')) }).finally(() => { checking = false })
        }, 250)
        const result = await backend.chat(request, controller.signal)
        if (revocation) throw new Error('GRANT_REVOKED')
        if (controller.signal.aborted) throw new Error('CANCELLED')
        await validGrant()
        return ok(result)
      } catch (error) {
        const reason: unknown = invocation?.signal.aborted ? invocation.signal.reason : error
        const code = reason instanceof Error && safeCodes.has(reason.message) ? reason.message : 'INFERENCE_UNAVAILABLE'
        return failure(requestId, code)
      } finally { if (timer) clearInterval(timer); if (invocation === active) active = undefined }
    },
  }
}

export const serveDeepTestInferenceAdapter = async (
  stateDir: string, grant: DeepTestInferenceGrant, input: Readable, output: Writable,
  refresh: () => Promise<DeepTestInferenceGrant>,
): Promise<void> => {
  const adapter = createDeepTestInferenceAdapter(grant, async () => {
    const next = await refresh()
    await currentInferenceConfig(stateDir, next)
    return next
  }, await createDeepTestInferenceBackends(stateDir, grant))
  const close = () => adapter.close()
  const stop = () => { close(); input.destroy() }
  input.once('end', close); input.once('close', close); output.once('close', stop); output.once('error', stop)
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let pending = Buffer.alloc(0)
  const send = async (response: DeepTestInferenceResponse) => {
    if (output.destroyed) return
    let line = `${JSON.stringify(response)}\n`
    if (Buffer.byteLength(line, 'utf8') > 20 * 1024 * 1024) line = `${JSON.stringify(failure(response.request_id, 'OUTPUT_BYTES_LIMIT'))}\n`
    if (!output.write(line)) await new Promise<void>((resolve, reject) => {
      const drained = () => { cleanup(); resolve() }
      const closed = () => { cleanup(); reject(new Error('OUTPUT_CLOSED')) }
      const cleanup = () => { output.off('drain', drained); output.off('close', closed); output.off('error', closed) }
      output.once('drain', drained); output.once('close', closed); output.once('error', closed)
    })
  }
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      while (pending.includes(0x0a)) {
        const index = pending.indexOf(0x0a)
        if (index > MAX_FRAME) throw new Error('FRAME_TOO_LARGE')
        const line = pending.subarray(0, index).toString('utf8')
        pending = pending.subarray(index + 1)
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { parsed = null }
        await send(await adapter.dispatch(parsed))
      }
      if (pending.byteLength > MAX_FRAME) throw new Error('FRAME_TOO_LARGE')
    }
    // A trailing partial frame is never an admitted inference request.
    if (pending.byteLength) await send(failure('invalid', 'REQUEST_INVALID'))
  } catch (error) {
    if (error instanceof Error && error.message === 'FRAME_TOO_LARGE') await send(failure('invalid', 'FRAME_TOO_LARGE'))
    else throw error
  } finally {
    close(); input.off('end', close); input.off('close', close); output.off('close', stop); output.off('error', stop)
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
  }
}
