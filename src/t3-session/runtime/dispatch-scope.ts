import * as Effect from 'effect/Effect'
import type { ExecutorT3LaneReply } from '@nessie/executor-protocol/t3-session'
import { SessionOperationScopeClosed } from './operation-scope.js'

type Reply = IteratorResult<ExecutorT3LaneReply>
type Demand = { close(): Promise<void> }

/**
 * Join lane demand before the held graph releases its services. This owns only
 * iterators: admission and the graph belong to the caller; provider turns are
 * never stopped by cancellation. No transport, replay buffer or queue is built.
 * Construct after graph acquisition, so its finalizer runs before graph cleanup.
 */
export const sessionDispatchScope = Effect.gen(function* () {
  const active = new Set<Demand>()
  const failures = new Set<unknown>()
  let open = true
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    open = false
    const results = await Promise.allSettled([...active].map(demand => demand.close()))
    for (const result of results) if (result.status === 'rejected') failures.add(result.reason)
    if (failures.size) throw new AggregateError([...failures], 'T3_RUNTIME_DEMAND_CLOSE_FAILED')
  }))

  return (source: (signal: AbortSignal) => AsyncIterable<ExecutorT3LaneReply>, caller: AbortSignal):
    AsyncIterableIterator<ExecutorT3LaneReply> => {
    const controller = new AbortController()
    let iterator: AsyncIterator<ExecutorT3LaneReply> | undefined
    let pending: Promise<Reply> | undefined
    let closing: Promise<void> | undefined
    let ended = false
    const close = (): Promise<void> => {
      if (closing) return closing
      ended = true
      controller.abort(caller.aborted ? caller.reason : undefined)
      caller.removeEventListener('abort', abort)
      closing = (async () => {
        // The adapter's signal interrupts a blocked pull. Join it before return
        // so cleanup cannot race an outstanding next on the original iterator.
        const errors: unknown[] = []
        if (pending) await pending.catch(error => {
          if (error !== controller.signal.reason) errors.push(error)
        })
        try { await iterator?.return?.() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'T3_RUNTIME_ITERATOR_CLOSE_FAILED')
      })().catch(error => { failures.add(error); throw error }).finally(() => { active.delete(demand) })
      return closing
    }
    const demand: Demand = { close }
    const abort = () => { void close().catch(() => undefined) }
    const start = () => {
      if (!open) throw new SessionOperationScopeClosed()
      caller.throwIfAborted()
      if (ended) return
      if (!iterator) {
        active.add(demand)
        caller.addEventListener('abort', abort, { once: true })
        iterator = source(controller.signal)[Symbol.asyncIterator]()
      }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      async next(): Promise<Reply> {
        if (!open) throw new SessionOperationScopeClosed()
        caller.throwIfAborted()
        if (ended) return { done: true, value: undefined }
        if (pending) throw new Error('T3_RUNTIME_CONCURRENT_DEMAND')
        try {
          start()
          pending = Promise.resolve(iterator!.next())
          const next = await pending
          pending = undefined
          caller.throwIfAborted()
          if (!open) throw new SessionOperationScopeClosed()
          if (next.done) await close()
          return next
        } catch (error) {
          pending = undefined
          await close()
          throw error
        }
      },
      async return(): Promise<Reply> {
        await close()
        return { done: true, value: undefined }
      },
      async throw(error?: unknown): Promise<Reply> {
        await close()
        throw error
      },
    }
  }
})
