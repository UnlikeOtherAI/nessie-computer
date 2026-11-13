import { win32 } from 'node:path'
import { T3ExecutionDestinationReceiptSchema, T3ExecutionDestinationFileReceiptSchema,
  type T3ExecutionDestinationReceipt, type T3ExecutionResourceReceipt } from '@nessie/executor-protocol'
import { CaptureFailure, requireCapture } from '../state/sqlite.js'
import type { SourceExchange } from './database.js'

/** Private graph storage only. Its path never enters a daemon/receipt DTO. */
export interface T3ExecutionDestinationScope {
  readonly receipt: Readonly<T3ExecutionDestinationReceipt>
  readonly directory: string
  readonly signal: AbortSignal
  recheck(): void
  holdFile(reference: string): void
}
const issued = new WeakSet<T3ExecutionDestinationScope>()
export function recognizeT3ExecutionDestination(scope: T3ExecutionDestinationScope): void {
  requireCapture(issued.has(scope), 'execution_destination_not_issued')
  scope.recheck()
}

/** Called only by the already-authenticated fixed resource companion. Native
 * derives the actual token's fixed directory and service retains its handles.
 * This metadata transport never issues a pending-row or provider admission. */
export async function withNativeExecutionDestination<A>(exchange: SourceExchange, resource: T3ExecutionResourceReceipt,
  parentSignal: AbortSignal, use: (scope: T3ExecutionDestinationScope) => Promise<A>): Promise<A> {
  parentSignal.throwIfAborted()
  const answer = exchange({ op: 'executionDestinationOpen' })
  const receipt = Object.freeze(T3ExecutionDestinationReceiptSchema.parse(answer.receipt))
  const directory = answer.directory
  requireCapture(receipt.resourceId === resource.resourceId
    && receipt.resourceGeneration === resource.resourceGeneration
    && typeof directory === 'string' && win32.isAbsolute(directory) && directory.startsWith('\\\\?\\Volume{')
    && !directory.includes('\0'), 'execution_destination_mismatch')
  const lifetime = new AbortController()
  const signal = AbortSignal.any([parentSignal, lifetime.signal])
  let active = true
  const recheck = () => {
    signal.throwIfAborted()
    requireCapture(active, 'execution_destination_closed')
    exchange({ op: 'recheck' })
    signal.throwIfAborted()
    requireCapture(active, 'execution_destination_closed')
  }
  const scope: T3ExecutionDestinationScope = Object.freeze({ receipt, signal,
    get directory() { recheck(); return directory }, recheck,
    holdFile(reference: string) {
      recheck()
      requireCapture(reference === 'journal' || /^t3-capture:v1:[a-f0-9]{64}$/u.test(reference),
        'execution_destination_reference_invalid')
      const held = T3ExecutionDestinationFileReceiptSchema.parse(
        exchange({ op: 'executionDestinationHoldFile', reference }).receipt)
      requireCapture(held.runtimeGeneration === receipt.runtimeGeneration && held.reference === reference,
        'execution_destination_file_mismatch')
      recheck()
    },
  })
  issued.add(scope)
  let result: A | undefined, failed = false, failure: unknown
  try { recheck(); result = await use(scope); recheck() }
  catch (error) { failed = true; failure = error }
  finally { active = false; issued.delete(scope); lifetime.abort(new CaptureFailure('execution_destination_closed')) }
  // The callback must join original SQL and writer cleanup first, even on abort.
  // A failed close is retained; native/service keep pins until actual graph exit.
  try { exchange({ op: 'executionDestinationClose' }) }
  catch (error) { if (failed) throw new AggregateError([failure, error], 'execution_destination_cleanup_failed'); throw error }
  if (failed) throw failure
  return result as A
}
