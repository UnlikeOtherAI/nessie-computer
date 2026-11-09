import { randomBytes } from 'node:crypto'
import { T3NativeExecutionOperationSchema, T3NativeExecutionOperationResultSchema,
  T3ExecutionSignedAdmissionSchema, T3NativeExecutionReceiptAcceptedSchema,
  T3EffectAuthorityCheckedSchema,
  type T3NativeExecutionOperation, type T3NativeExecutionOperationResult,
} from '@nessie/executor-protocol/t3-session'
import type { T3NativeExecutionTransport } from '../../t3-native-execution-transport.js'
import { protectedRuntimeRefused } from './protected-wire.js'

export type ProtectedNativeRequest = { type: 'native'; operationId: string; callId: string;
  operation: T3NativeExecutionOperation }
export type ProtectedNativeResult = { type: 'native-result'; operationId: string; callId: string;
  value: T3NativeExecutionOperationResult } | { type: 'native-refused'; operationId: string; callId: string }
export interface ProtectedNativeRelay {
  register(port: T3NativeExecutionTransport, parent: AbortSignal): { operationId: string; close(): Promise<void> }
  receive(message: ProtectedNativeRequest): void
  close(): Promise<void>
}
export interface ProtectedNativeClient {
  open(operationId: string, parent: AbortSignal): { port: T3NativeExecutionTransport; close(): Promise<void> }
  receive(message: ProtectedNativeResult): void
  close(): Promise<void>
}

/** Daemon side. Only an actual open registers its captured transport. The
 * protected child can select finite methods of that port, never its original
 * request, delivery, machine state, key or another operation's authority. */
export function createProtectedNativeRelay(send: (result: ProtectedNativeResult) => Promise<void>,
  fail: () => void): ProtectedNativeRelay {
  type Entry = { port: T3NativeExecutionTransport; signal: AbortSignal; stop: AbortController;
    seen: Set<string>; pending: Set<Promise<void>> }
  const entries = new Map<string, Entry>()
  let live = true
  return {
    register(port: T3NativeExecutionTransport, parent: AbortSignal) {
      if (!live || parent.aborted || entries.size >= 64) throw protectedRuntimeRefused()
      const operationId = randomBytes(32).toString('hex'), stop = new AbortController()
      const entry: Entry = { port, stop, signal: AbortSignal.any([parent, stop.signal]),
        seen: new Set(), pending: new Set() }
      entries.set(operationId, entry)
      return { operationId, async close() {
        stop.abort()
        // Remove before joining: a late request can never reopen this operation.
        entries.delete(operationId)
        while (entry.pending.size) await Promise.allSettled([...entry.pending])
      } }
    },
    receive(message: ProtectedNativeRequest): void {
      const entry = entries.get(message.operationId)
      if (!live || !entry || entry.signal.aborted || entry.seen.has(message.callId)
        || entry.seen.size >= 4096 || entry.pending.size >= 8) throw protectedRuntimeRefused()
      const operation = T3NativeExecutionOperationSchema.parse(message.operation)
      entry.seen.add(message.callId)
      const job = (async () => {
        try {
          entry.signal.throwIfAborted()
          const value = operation.operation === 'execution.phase'
            ? await entry.port.phase(operation.input, entry.signal)
            : operation.operation === 'execution.frame'
              ? await entry.port.frame(operation.input, entry.signal)
              : operation.operation === 'execution.secretRead'
                ? await entry.port.secretRead(operation.input, entry.signal)
                : operation.operation === 'execution.preclaim'
                  ? await entry.port.preclaim(operation.input, entry.signal)
                  : operation.operation === 'execution.effect'
                    ? await entry.port.effect(entry.signal)
                : await entry.port.receipt(operation.receipt, entry.signal)
          entry.signal.throwIfAborted()
          if (!live || entries.get(message.operationId) !== entry) throw protectedRuntimeRefused()
          await send({ type: 'native-result', operationId: message.operationId, callId: message.callId,
            value: T3NativeExecutionOperationResultSchema.parse(value) })
        } catch {
          // An uncertain phase/frame/secret read is never retried. The operation's caller
          // must unwind and join its held native processes before releasing SQL.
          entry.stop.abort()
          await send({ type: 'native-refused', operationId: message.operationId, callId: message.callId })
        }
      })()
      entry.pending.add(job)
      void job.finally(() => entry.pending.delete(job)).catch(fail)
    },
    async close(): Promise<void> {
      live = false
      const held = [...entries.values()]
      entries.clear()
      for (const entry of held) entry.stop.abort()
      for (const entry of held) while (entry.pending.size) await Promise.allSettled([...entry.pending])
    },
  }
}

/** Protected child side. A port closes with its exact open callback. No
 * application effect, callback result or parsed envelope is promoted to proof;
 * native independently verifies every returned signed admission at consume. */
export function createProtectedNativeClient(send: (request: ProtectedNativeRequest) => Promise<void>):
  ProtectedNativeClient {
  type Waiting = { resolve(value: T3NativeExecutionOperationResult): void; reject(error: Error): void }
  type Entry = { stop: AbortController; pending: Map<string, Waiting>; work: Set<Promise<unknown>>; used: number }
  const entries = new Map<string, Entry>()
  const retired = new Set<string>()
  let live = true
  const stop = (entry: Entry) => {
    entry.stop.abort()
    for (const waiting of entry.pending.values()) waiting.reject(protectedRuntimeRefused())
    entry.pending.clear()
  }
  return {
    open(operationId: string, parent: AbortSignal): { port: T3NativeExecutionTransport; close(): Promise<void> } {
      if (!live || entries.has(operationId) || retired.has(operationId) || retired.size >= 4096
        || entries.size >= 64 || parent.aborted) throw protectedRuntimeRefused()
      retired.add(operationId)
      const entry: Entry = { stop: new AbortController(), pending: new Map(), work: new Set(), used: 0 }
      entries.set(operationId, entry)
      const parentAbort = () => stop(entry)
      parent.addEventListener('abort', parentAbort, { once: true })
      if (parent.aborted) parentAbort()
      const invoke = async (operation: T3NativeExecutionOperation, caller: AbortSignal) => {
        const signal = AbortSignal.any([parent, caller, entry.stop.signal])
        signal.throwIfAborted()
        if (!live || entries.get(operationId) !== entry || entry.pending.size >= 8 || entry.used >= 4096) {
          throw protectedRuntimeRefused()
        }
        const callId = randomBytes(32).toString('hex')
        entry.used++
        const abort = () => stop(entry)
        signal.addEventListener('abort', abort, { once: true })
        // Resource bound only. The backend/native five-second admission remains
        // independent and is never extended by the private pipe's timeout.
        const timer = setTimeout(abort, 10_000)
        timer.unref()
        try {
          const result = new Promise<T3NativeExecutionOperationResult>((resolve, reject) =>
            entry.pending.set(callId, { resolve, reject }))
          void result.catch(() => undefined)
          signal.throwIfAborted()
          await send({ type: 'native', operationId, callId,
            operation: T3NativeExecutionOperationSchema.parse(operation) })
          const value = await result
          signal.throwIfAborted()
          return value
        } catch { stop(entry); throw protectedRuntimeRefused() }
        finally { clearTimeout(timer); signal.removeEventListener('abort', abort); entry.pending.delete(callId) }
      }
      const tracked = (operation: T3NativeExecutionOperation, signal: AbortSignal) => {
        const work = invoke(operation, signal)
        entry.work.add(work)
        void work.finally(() => entry.work.delete(work)).catch(() => undefined)
        return work
      }
      const port = Object.freeze<T3NativeExecutionTransport>({
        phase: async (input, signal) => T3ExecutionSignedAdmissionSchema.parse(
          await tracked({ operation: 'execution.phase', input }, signal)),
        frame: async (input, signal) => T3ExecutionSignedAdmissionSchema.parse(
          await tracked({ operation: 'execution.frame', input }, signal)),
        secretRead: async (input, signal) => T3ExecutionSignedAdmissionSchema.parse(
          await tracked({ operation: 'execution.secretRead', input }, signal)),
        preclaim: async (input, signal) => T3ExecutionSignedAdmissionSchema.parse(
          await tracked({ operation: 'execution.preclaim', input }, signal)),
        effect: async signal => T3EffectAuthorityCheckedSchema.parse(
          await tracked({ operation: 'execution.effect' }, signal)),
        receipt: async (receipt, signal) => T3NativeExecutionReceiptAcceptedSchema.parse(
          await tracked({ operation: 'execution.receipt', receipt }, signal)),
      })
      return { port, async close() {
        entries.delete(operationId)
        parent.removeEventListener('abort', parentAbort)
        stop(entry)
        while (entry.work.size) await Promise.allSettled([...entry.work])
      } }
    },
    receive(message: ProtectedNativeResult): void {
      const entry = entries.get(message.operationId), waiting = entry?.pending.get(message.callId)
      if (!live || !entry || !waiting) throw protectedRuntimeRefused()
      entry.pending.delete(message.callId)
      if (message.type === 'native-refused') { waiting.reject(protectedRuntimeRefused()); stop(entry) }
      else waiting.resolve(T3NativeExecutionOperationResultSchema.parse(message.value))
    },
    async close(): Promise<void> {
      live = false
      const held = [...entries.values()]
      entries.clear()
      for (const entry of held) stop(entry)
      for (const entry of held) while (entry.work.size) await Promise.allSettled([...entry.work])
    },
  }
}
