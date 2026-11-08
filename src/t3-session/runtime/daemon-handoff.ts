import { createHash } from 'node:crypto'
import { RetainedImportChallengeSchema, RetainedImportLocalReceiptSchema } from '@nessie/executor-protocol'
import { z } from 'zod'
import type { ExecutorLocalState } from '../../state-store.js'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'
import { requireCapture } from '../state/sqlite.js'
import { withCapturedRetainedRuntime } from './retained-capture.js'

export const RetainedParentRequest = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('retained-import.begin'),
    challenge: RetainedImportChallengeSchema, receipt: RetainedImportLocalReceiptSchema,
    expiresAtMs: z.number().int().nonnegative().safe() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('retained-import.cancel'),
    challengeId: z.string().uuid() }).strict(),
])
export type RetainedParentRequest = z.infer<typeof RetainedParentRequest>
export type RetainedParentStatus = { version: 1; kind: 'retained-import';
  challengeId?: string; status: 'ready' | 'accepted' | 'published' | 'stopping' | 'closed' | 'failed' | 'refused' }

const untilStopped = (signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', () => resolve(), { once: true })
})
type Running = { id: string; digest: string; stop: AbortController; abort: AbortController;
  done: Promise<void>; status: RetainedParentStatus['status']; lane?: T3SessionLaneRuntime }

/** One transient import owner inside the already-claimed daemon. The inherited
 * pipe transfers a receipt, never approval or authority. No persisted request,
 * second serveExecutor, replacement SQL graph or provider launch exists here. */
export function createRetainedDaemonRuntime(stateDirectory: string, state: () => ExecutorLocalState,
  wake: () => void, report: (status: RetainedParentStatus) => void) {
  let accepting = true
  let running: Running | undefined
  let last: { id: string; digest: string; status: RetainedParentStatus['status'] } | undefined
  const emit = (id: string, status: RetainedParentStatus['status']) =>
    report({ version: 1, kind: 'retained-import', challengeId: id, status })
  const withdraw = (job: Running) => { job.lane = undefined; wake() }
  const stopCurrent = async () => {
    const job = running
    if (!job) return
    withdraw(job)
    job.status = 'stopping'
    job.stop.abort()
    await job.done
  }
  const lane: T3SessionLaneRuntime = {
    describe: async () => {
      const job = running
      if (job?.lane) {
        const rows = await job.lane.describe()
        return running === job && job.lane ? rows : []
      }
      return []
    },
    open: (request, signal, delivery) => {
      const target = running?.lane
      requireCapture(target, 'retained_runtime_not_published')
      return target.open(request, signal, delivery)
    },
  }
  const accept = (request: RetainedParentRequest) => {
    requireCapture(accepting, 'retained_handoff_closed')
    if (request.operation === 'retained-import.cancel') {
      if (running?.id === request.challengeId) {
        withdraw(running)
        running.status = 'stopping'
        running.stop.abort()
        emit(running.id, 'stopping')
      } else emit(request.challengeId, last?.id === request.challengeId ? last.status : 'refused')
      return
    }
    const { challenge, receipt } = request
    const id = challenge.challengeId
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    if (running?.id === id || last?.id === id) {
      const previous = running?.id === id ? running : last!
      requireCapture(previous.digest === digest, 'retained_handoff_conflict')
      emit(id, previous.status)
      return
    }
    requireCapture(!running, 'retained_handoff_busy')
    requireCapture(challenge.executorId === state().executorId && receipt.challengeId === id,
      'retained_handoff_executor_mismatch')
    requireCapture(challenge.selection.kind === 'whole_source', 'retained_handoff_whole_source_required')
    const deadline = Math.min(request.expiresAtMs, receipt.expiresAtMs, challenge.grantExpiresAtMs, Date.now() + 300_000)
    requireCapture(deadline > Date.now(), 'retained_handoff_expired')
    const job: Running = { id, digest, stop: new AbortController(), abort: new AbortController(),
      done: Promise.resolve(), status: 'accepted' }
    running = job
    const timer = setTimeout(() => {
      withdraw(job)
      job.abort.abort(new Error('retained_handoff_expired'))
    }, deadline - Date.now())
    timer.unref()
    // Track the complete producer Promise; close never detaches capture,
    // publication, graph demand, native/source release or server withdrawal.
    job.done = (async () => {
      try {
        await withCapturedRetainedRuntime(stateDirectory, { challenge, receipt }, async runtime => {
          if (job.stop.signal.aborted) return
          await runtime.graph.publish(runtime.held.local.bootstrapAuthority('publish'), state, runtime.signal)
          if (job.stop.signal.aborted) return
          runtime.signal.throwIfAborted()
          job.lane = runtime.lane
          job.status = 'published'
          emit(id, 'published')
          wake()
          try { await untilStopped(AbortSignal.any([job.stop.signal, runtime.signal])) }
          finally { withdraw(job) }
          // Normal cancellation returns cooperatively. The captured producer
          // drains and revokes before its successful completion is acknowledged.
        }, job.abort.signal)
        job.status = 'closed'
      } catch {
        // Never expose paths, receipts, tokens or claim a completed native
        // withdrawal when any source/authority/finalizer failed.
        job.status = 'failed'
        accepting = false
      } finally {
        clearTimeout(timer)
        withdraw(job)
        last = { id, digest, status: job.status }
        if (running === job) running = undefined
        emit(id, job.status)
      }
    })()
    emit(id, 'accepted')
  }
  return {
    lane, stopCurrent,
    accept(request: RetainedParentRequest) {
      try { accept(request) } catch {
        const id = request.operation === 'retained-import.begin' ? request.challenge.challengeId : request.challengeId
        // Conflicting/late delivery cannot turn an active or failed producer
        // into a pre-admission refusal and release its native issuer pipe.
        emit(id, running?.id === id ? running.status : last?.id === id ? last.status : 'refused')
      }
    },
    busy: () => running !== undefined,
    async close() {
      accepting = false
      await stopCurrent()
      requireCapture(last?.status !== 'failed', 'retained_handoff_shutdown_unproved')
    },
  }
}
