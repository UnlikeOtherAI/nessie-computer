import { canonicalExecutorJson, T3ExecutionOriginalCommandEdgeSchema,
  type T3ExecutionOriginalCommandEdge, type T3ExecutionResourceReceipt } from '@nessie/executor-protocol'
import { T3ExecutionGraphPayloadSchema, type T3ExecutionGraph } from '@nessie/executor-protocol/t3-session'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { SourceExchange } from './database.js'

export interface SessionOriginalCommandSink {
  /** Only the original creation/accepted callbacks call this internal sink.
   * The native service checks its own actual SQL before recording acceptance. */
  record(edge: T3ExecutionOriginalCommandEdge): Promise<void>
  /** Terminal metadata withdrawal only; never deletes or resets durable SQL. */
  retire(): void
}

/** Metadata consistency only. The service must recognize its exact accepted Graph. */
export function executionGraphCandidate(graph: T3ExecutionGraph, receipt: T3ExecutionResourceReceipt) {
  const { custody, ...candidate } = T3ExecutionGraphPayloadSchema.parse(graph)
  const source = receipt.evidence.source
  requireCapture(canonicalExecutorJson(custody) === canonicalExecutorJson(receipt.custody)
    && candidate.binding.executorId === source.executorId && candidate.binding.environmentId === source.environmentId
    && candidate.binding.sourceRootKey === source.physicalRootKey, 'execution_destination_graph_mismatch')
  return candidate
}

/** Same authenticated resource channel; no signer, caller SQL or new companion.
 * A close failure invalidates the source owner rather than preserving usable
 * lineage metadata. The resource owner's existing finally joins native cleanup. */
export async function withExecutionCommandCapture<A>(exchange: SourceExchange, receipt: T3ExecutionResourceReceipt,
  recheck: () => Promise<void>, invalidateSource: () => void, graph: T3ExecutionGraph, retentionExpiresAt: number,
  signal: AbortSignal, use: (sink: SessionOriginalCommandSink) => Promise<A>): Promise<A> {
  const candidate = executionGraphCandidate(graph, receipt)
  signal.throwIfAborted()
  requireCapture(Number.isSafeInteger(retentionExpiresAt) && retentionExpiresAt > Date.now(),
    'execution_command_capture_expired')
  await recheck()
  signal.throwIfAborted()
  try {
    const opened = exchange({ op: 'executionCommandOpen', graph: candidate, retentionExpiresAt })
    requireCapture(Object.keys(opened).length === 1 && opened.opened === true, 'execution_command_capture_unavailable')
  } catch { invalidateSource(); throw new CaptureFailure('execution_command_capture_unavailable') }
  let live = true, failure: unknown
  const pending = new Set<Promise<void>>()
  const close = () => {
    if (!live) return
    live = false
    try {
      const result = exchange({ op: 'executionCommandClose', graph: candidate })
      requireCapture(Object.keys(result).length === 1 && result.closed === true, 'execution_command_capture_unavailable')
    } catch {
      failure ??= new CaptureFailure('execution_command_capture_unavailable')
      invalidateSource()
    }
  }
  const current = async () => {
    signal.throwIfAborted()
    requireCapture(live && Date.now() < retentionExpiresAt, 'execution_command_capture_closed')
    await recheck()
    signal.throwIfAborted()
    requireCapture(live && Date.now() < retentionExpiresAt, 'execution_command_capture_closed')
  }
  signal.addEventListener('abort', close, { once: true })
  const timer = setTimeout(close, Math.min(2_147_483_647, Math.max(0, retentionExpiresAt - Date.now())))
  timer.unref()
  if (signal.aborted) close()
  const sink = Object.freeze<SessionOriginalCommandSink>({ retire: close, record: input => {
    let edge: T3ExecutionOriginalCommandEdge
    try { edge = T3ExecutionOriginalCommandEdgeSchema.parse(input) }
    catch {
      failure ??= new CaptureFailure('execution_command_capture_unavailable')
      close()
      return Promise.reject(failure)
    }
    const work = (async () => {
      await current()
      const result = exchange({ op: 'executionCommandRecord', graph: candidate, edge })
      requireCapture(Object.keys(result).length === 1 && result.recorded === true, 'execution_command_capture_unavailable')
      await current()
    })()
    pending.add(work)
    void work.catch(error => { failure ??= error; close() }).finally(() => pending.delete(work))
    return work
  } })
  try {
    await current()
    const result = await use(sink)
    // Original-owner retirement may precede successful callback return. The
    // enclosing parent/source and deadline must still be current; the retired
    // sink remains unusable while its cleanup and pending calls drain below.
    await recheck()
    signal.throwIfAborted()
    requireCapture(Date.now() < retentionExpiresAt, 'execution_command_capture_expired')
    return result
  } finally {
    close()
    clearTimeout(timer)
    signal.removeEventListener('abort', close)
    while (pending.size) await Promise.allSettled([...pending])
    if (failure) throw failure
  }
}
