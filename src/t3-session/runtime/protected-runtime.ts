import { randomBytes } from 'node:crypto'
import { canonicalExecutorJson } from '@nessie/executor-protocol'
import { encodeExecutorT3LaneOperation, T3ExecutionInspectionSchema, T3ExecutionReceiptSchema,
  T3InspectionRuntimeAnnouncementSchema, type ExecutorT3LaneOperation,
  type T3InspectionRuntimeAnnouncement } from '@nessie/executor-protocol/t3-session'
import type { ExecutorLocalState } from '../../state-store.js'
import type { T3SessionLaneRuntime } from '../../t3-session-lane.js'
import { startProtectedT3Graph, type ProtectedT3Process } from '../../t3-protected-process.js'
import { machineT3Sources } from '../source/owner.js'
import type { SessionInspectionRuntime } from './inspection-runtime.js'
import { ProtectedRuntimeInputSchema, ProtectedRuntimeOutputSchema, readProtectedRuntimeFrames,
  writeProtectedRuntimeFrame, protectedRuntimeRefused, type ProtectedRuntimeInput } from './protected-wire.js'

type Call = { resolve(value: unknown): void; reject(error: Error): void }
type Job = {
  readonly key: string; readonly identity: string; readonly stop: AbortController;
  readonly calls: Map<string, Call>; readonly inspections: Map<string, { signal: AbortSignal; abort(): void }>;
  started: Promise<void>; child?: ProtectedT3Process; reading?: Promise<void>; closing?: Promise<void>;
  announcement?: T3InspectionRuntimeAnnouncement;
  cleared?: boolean; retryAt?: number;
}
const identity = (state: ExecutorLocalState) => canonicalExecutorJson({ executorId: state.executorId,
  apiBaseUrl: state.apiBaseUrl, machinePublicKey: state.machinePublicKey, connectionEpoch: state.connectionEpoch })

/** One collection inside the existing daemon lease and source registry. Each
 * immutable protected graph owns one actual source/writer. This never creates a
 * daemon, provider or HTTP listener. Source announcements are inspection only. */
export function createProtectedSessionRuntime(state: () => ExecutorLocalState, wake: () => void) {
  const jobs = new Map<string, Job>()
  let live = true
  let cleanupFailure: unknown
  let refreshing: Promise<void> | undefined
  const close = (job: Job): Promise<void> => {
    if (job.closing) return job.closing
    job.announcement = undefined
    job.stop.abort()
    for (const call of job.calls.values()) call.reject(protectedRuntimeRefused())
    job.calls.clear()
    for (const held of job.inspections.values()) held.signal.removeEventListener('abort', held.abort)
    job.inspections.clear()
    wake()
    job.closing = (async () => {
      await job.started.catch(() => undefined)
      // Terminate resolves only after service-positive kernel Job clearance.
      if (job.child) { await job.child.terminate(); await job.child.closed }
      await job.reading?.catch(() => undefined)
      if (job.child) { job.cleared = true; job.retryAt = Date.now() + 20_000 }
    })()
    void job.closing.catch(error => { cleanupFailure ??= error })
    return job.closing
  }
  const assertCurrent = (job: Job) => {
    if (!live || cleanupFailure || job.stop.signal.aborted || job.identity !== identity(state())) {
      void close(job)
      throw protectedRuntimeRefused()
    }
  }
  const call = async (job: Job, input: ProtectedRuntimeInput, signal?: AbortSignal): Promise<unknown> => {
    assertCurrent(job)
    if (!job.child || !('callId' in input) || job.calls.size >= 64) throw protectedRuntimeRefused()
    const onAbort = () => { void close(job) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timer = setTimeout(onAbort, 10_000)
    timer.unref()
    try {
      assertCurrent(job)
      const answer = new Promise<unknown>((resolve, reject) => job.calls.set(input.callId, { resolve, reject }))
      void answer.catch(() => undefined)
      await writeProtectedRuntimeFrame(job.child.stdin, ProtectedRuntimeInputSchema.parse(input))
      const result = await answer
      assertCurrent(job)
      return result
    } catch (error) { await close(job); throw error }
    finally {
      job.calls.delete(input.callId)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  const callId = () => randomBytes(32).toString('hex')
  const release = async (inspectionId: string) => {
    for (const job of jobs.values()) {
      const held = job.inspections.get(inspectionId)
      if (!held) continue
      held.signal.removeEventListener('abort', held.abort)
      job.inspections.delete(inspectionId)
      if (job.closing) await job.closing
      else await call(job, { type: 'release', callId: callId(), inspectionId })
    }
  }
  const find = (request: ExecutorT3LaneOperation): Job => {
    const matches = [...jobs.values()].filter(job => job.announcement?.environmentId === request.environmentId
      && job.announcement.runtimeGeneration === request.runtimeGeneration
      && job.announcement.sourceRevision === request.sourceRevision && !job.stop.signal.aborted)
    if (matches.length !== 1) throw protectedRuntimeRefused()
    const job = matches[0]!
    assertCurrent(job)
    if (state().executorId !== request.executorId || state().connectionEpoch !== request.connectionEpoch) {
      throw protectedRuntimeRefused()
    }
    return job
  }
  const runtime: T3SessionLaneRuntime & SessionInspectionRuntime = {
    describe: async () => [],
    describeInspections: async () => {
      const rows: T3InspectionRuntimeAnnouncement[] = []
      for (const job of jobs.values()) {
        if (!job.announcement || job.stop.signal.aborted) continue
        const observed = T3InspectionRuntimeAnnouncementSchema.array().length(1).parse(
          await call(job, { type: 'describe', callId: callId() }))
        if (canonicalExecutorJson(observed[0]) !== canonicalExecutorJson(job.announcement)) {
          await close(job)
          throw protectedRuntimeRefused()
        }
        rows.push(observed[0]!)
      }
      return rows
    },
    inspect: async (request, signal, delivery) => {
      const job = find(request)
      const challenge = T3ExecutionInspectionSchema.parse(JSON.parse(delivery.inspection.payload))
      if (job.inspections.has(challenge.inspectionId)) throw protectedRuntimeRefused()
      const abort = () => { void release(challenge.inspectionId).catch(() => { void close(job) }) }
      job.inspections.set(challenge.inspectionId, { signal, abort })
      signal.addEventListener('abort', abort, { once: true })
      try {
        return T3ExecutionReceiptSchema.parse(await call(job, { type: 'inspect', callId: callId(),
          inspectionId: challenge.inspectionId, request: encodeExecutorT3LaneOperation(request), delivery }, signal))
      } catch (error) { await close(job); throw error }
    },
    acceptInspection: async (request, accepted, signal) => {
      const job = find(request)
      if (job.inspections.get(accepted.inspectionId)?.signal !== signal) throw protectedRuntimeRefused()
      await call(job, { type: 'accept', callId: callId(),
        request: encodeExecutorT3LaneOperation(request), accepted }, signal)
    },
    releaseInspection: release,
    // Cold availability is not execution. The original admitted activation and
    // serializer must be composed here before this method can dispatch commands.
    open: async function* () { throw protectedRuntimeRefused() },
  }
  const begin = (key: string) => {
    const job: Job = { key, identity: identity(state()), stop: new AbortController(), calls: new Map(),
      inspections: new Map(), started: Promise.resolve() }
    jobs.set(key, job)
    job.started = Promise.resolve().then(async () => {
      job.child = await startProtectedT3Graph(state().executorId, job.stop.signal)
      job.child.stderr.resume()
      job.child.on('error', () => { void close(job) })
      const timer = setTimeout(() => { void close(job) }, 300_000)
      timer.unref()
      job.reading = (async () => {
        try {
          for await (const raw of readProtectedRuntimeFrames(job.child!.stdout, job.stop.signal)) {
            assertCurrent(job)
            const message = ProtectedRuntimeOutputSchema.parse(raw)
            if (message.type === 'ready') {
              if (job.announcement) throw protectedRuntimeRefused()
              clearTimeout(timer)
              job.announcement = message.announcements[0]!
              wake()
            } else {
              const waiting = job.calls.get(message.callId)
              if (!waiting) throw protectedRuntimeRefused()
              job.calls.delete(message.callId)
              if (message.type === 'refused') waiting.reject(protectedRuntimeRefused())
              else waiting.resolve(message.value)
            }
          }
        } finally { clearTimeout(timer) }
      })()
      void job.reading.finally(() => { void close(job) }).catch(() => undefined)
      await writeProtectedRuntimeFrame(job.child.stdin, { type: 'source', admittedRootKey: key })
      assertCurrent(job)
    })
    void job.started.catch(() => { void close(job) })
  }
  return {
    runtime,
    refresh(): Promise<void> {
      if (refreshing) return refreshing
      refreshing = (async () => {
        if (!live || cleanupFailure) throw protectedRuntimeRefused()
        if (process.platform !== 'win32' || process.env.NESSIE_EXECUTOR_PACKAGED_CLI !== '1') return
        const snapshot = state()
        const manifest = await machineT3Sources(snapshot.executorId).manifest()
        if (!live || identity(snapshot) !== identity(state()) || manifest.homes.length > 64) {
          throw protectedRuntimeRefused()
        }
        const selected = new Set(manifest.homes.map(home => home.admittedRootKey))
        for (const [key, job] of jobs) if (!selected.has(key) || job.identity !== identity(snapshot)
          || job.cleared && job.retryAt !== undefined && job.retryAt <= Date.now()) {
          await close(job)
          jobs.delete(key)
        }
        for (const key of selected) if (!jobs.has(key)) begin(key)
      })().finally(() => { refreshing = undefined })
      return refreshing
    },
    busy: () => [...jobs.values()].some(job => job.inspections.size > 0 || job.calls.size > 0),
    async stopCurrent(): Promise<void> {
      await refreshing?.catch(() => undefined)
      await Promise.all([...jobs.values()].map(close))
      jobs.clear()
      if (cleanupFailure) throw cleanupFailure
    },
    async close(): Promise<void> { live = false; await this.stopCurrent() },
  }
}
