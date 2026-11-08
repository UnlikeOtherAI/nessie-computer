import { decodeExecutorT3LaneOperation, T3ExecutionInspectionSchema } from '@nessie/executor-protocol/t3-session'
import { readProtectedT3GraphStartup } from '../../t3-protected-process.js'
import { ProtectedRuntimeInputSchema, readProtectedRuntimeFrames, writeProtectedRuntimeFrame,
  protectedRuntimeRefused, type ProtectedRuntimeInput } from './protected-wire.js'
import { withProtectedSessionSource } from './protected-source.js'
import type { HeldSessionInspectionRuntime } from './inspection-runtime.js'

/** SYSTEM's fixed immutable graph CLI. Reads the private startup exactly once;
 * subsequent frames carry only source selectors and finite inspection demand.
 * It never loads enrollment state, receives a machine key or spawns a fallback. */
export async function runProtectedT3SessionRuntime(args: readonly string[]): Promise<void> {
  if (args.length || process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') {
    throw protectedRuntimeRefused()
  }
  const startup = await readProtectedT3GraphStartup()
  const stop = new AbortController()
  const pending = new Set<Promise<void>>()
  const calls = new Set<string>()
  const parents = new Map<string, AbortController>()
  let sourceJob: Promise<void> | undefined
  let current: HeldSessionInspectionRuntime | undefined
  let failed = false
  const shutdown = () => {
    stop.abort()
    for (const parent of parents.values()) parent.abort()
  }
  const write = (value: unknown) => writeProtectedRuntimeFrame(process.stdout, value)
  const dispatch = async (message: Exclude<ProtectedRuntimeInput, { type: 'source' | 'close' }>) => {
    if (stop.signal.aborted || !current) throw protectedRuntimeRefused()
    const held = current
    if (message.type === 'describe') return held.runtime.describeInspections()
    if (message.type === 'release') {
      parents.get(message.inspectionId)?.abort()
      await held.runtime.releaseInspection(message.inspectionId)
      parents.delete(message.inspectionId)
      return null
    }
    const request = decodeExecutorT3LaneOperation(message.request)
    if (request.executorId !== startup.executorId) throw protectedRuntimeRefused()
    if (message.type === 'inspect') {
      const challenge = T3ExecutionInspectionSchema.parse(JSON.parse(message.delivery.inspection.payload))
      if (challenge.inspectionId !== message.inspectionId || parents.has(message.inspectionId) || parents.size >= 64) {
        throw protectedRuntimeRefused()
      }
      const parent = new AbortController()
      parents.set(message.inspectionId, parent)
      try { return await held.runtime.inspect(request, parent.signal, message.delivery) }
      catch (error) {
        parent.abort()
        await held.runtime.releaseInspection(message.inspectionId)
        parents.delete(message.inspectionId)
        throw error
      }
    }
    const parent = parents.get(message.accepted.inspectionId)
    if (!parent) throw protectedRuntimeRefused()
    await held.runtime.acceptInspection(request, message.accepted, parent.signal)
    return null
  }
  try {
    for await (const raw of readProtectedRuntimeFrames(process.stdin, stop.signal)) {
      const message = ProtectedRuntimeInputSchema.parse(raw)
      if (message.type === 'close') break
      if (message.type === 'source') {
        if (sourceJob) throw protectedRuntimeRefused()
        sourceJob = withProtectedSessionSource(startup, message.admittedRootKey, async held => {
          current = held
          const onLoss = () => { current = undefined; shutdown() }
          held.signal.addEventListener('abort', onLoss, { once: true })
          try {
            if (held.signal.aborted) throw protectedRuntimeRefused()
            await write({ type: 'ready', announcements: await held.runtime.describeInspections() })
            await new Promise<void>(resolve => {
              if (stop.signal.aborted) resolve()
              else stop.signal.addEventListener('abort', () => resolve(), { once: true })
            })
            while (pending.size) await Promise.allSettled([...pending])
          } finally { current = undefined; held.signal.removeEventListener('abort', onLoss) }
        }, stop.signal).catch(() => { failed = true; shutdown() })
        continue
      }
      if (calls.has(message.callId) || calls.size >= 4096 || pending.size >= 64) throw protectedRuntimeRefused()
      calls.add(message.callId)
      const job = Promise.resolve().then(async () => {
        try { await write({ type: 'result', callId: message.callId, value: await dispatch(message) }) }
        catch { await write({ type: 'refused', callId: message.callId }) }
      }).catch(() => { failed = true; shutdown() })
      pending.add(job)
      void job.finally(() => pending.delete(job))
    }
  } finally {
    shutdown()
    while (pending.size) await Promise.allSettled([...pending])
    await sourceJob
  }
  if (failed) throw protectedRuntimeRefused()
}
