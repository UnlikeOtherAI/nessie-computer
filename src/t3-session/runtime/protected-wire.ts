import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { T3ExecutionSignedAdmissionSchema, T3LaneInspectionAcceptedSchema,
  T3InspectionRuntimeAnnouncementSchema, T3_LANE_LIMITS,
  T3NativeExecutionOperationSchema, T3NativeExecutionOperationResultSchema } from '@nessie/executor-protocol/t3-session'

const id = z.string().regex(/^[a-f0-9]{64}$/u)
const call = { callId: id }
const parent = { inspectionId: id }
const operation = { operationId: id }
export const ProtectedRuntimeInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('source'), admittedRootKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u) }).strict(),
  z.object({ type: z.literal('inspect'), ...call, ...parent, request: z.unknown(),
    delivery: z.object({ inspection: T3ExecutionSignedAdmissionSchema,
      relayHmac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
      retentionExpiresAt: z.string().datetime() }).strict() }).strict(),
  z.object({ type: z.literal('accept'), ...call, request: z.unknown(),
    accepted: T3LaneInspectionAcceptedSchema }).strict(),
  z.object({ type: z.literal('release'), ...call, ...parent }).strict(),
  z.object({ type: z.literal('describe'), ...call }).strict(),
  z.object({ type: z.literal('native-result'), ...operation, ...call,
    value: T3NativeExecutionOperationResultSchema }).strict(),
  z.object({ type: z.literal('native-refused'), ...operation, ...call }).strict(),
  z.object({ type: z.literal('close') }).strict(),
])
export type ProtectedRuntimeInput = z.infer<typeof ProtectedRuntimeInputSchema>
export const ProtectedRuntimeOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'),
    announcements: T3InspectionRuntimeAnnouncementSchema.array().length(1) }).strict(),
  z.object({ type: z.literal('result'), ...call, value: z.unknown() }).strict(),
  z.object({ type: z.literal('refused'), ...call }).strict(),
  z.object({ type: z.literal('native'), ...operation, ...call, operation: T3NativeExecutionOperationSchema }).strict(),
])
const limit = T3_LANE_LIMITS.requestBytes + T3_LANE_LIMITS.controlBytes
export const protectedRuntimeRefused = () => new Error('T3_PROTECTED_RUNTIME_REFUSED')

/** One bounded NDJSON control channel after the private SYSTEM startup frame.
 * Cancellation closes this channel; it never supplies a process or input grant. */
export async function* readProtectedRuntimeFrames(input: Readable, signal: AbortSignal): AsyncIterable<unknown> {
  let held = Buffer.alloc(0)
  const stop = () => { input.destroy() }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    for await (const value of input) {
      if (signal.aborted) break
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        if (held.length + end - offset > limit) throw protectedRuntimeRefused()
        held = Buffer.concat([held, bytes.subarray(offset, end)])
        offset = end + 1
        if (newline < 0) break
        if (!held.length) throw protectedRuntimeRefused()
        const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(held)) as unknown
        held.fill(0)
        held = Buffer.alloc(0)
        yield frame
      }
    }
    if (held.length && !signal.aborted) throw protectedRuntimeRefused()
  } finally { held.fill(0); signal.removeEventListener('abort', stop) }
}

export async function writeProtectedRuntimeFrame(output: Writable, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > limit || output.destroyed) throw protectedRuntimeRefused()
  await new Promise<void>((resolve, reject) => {
    output.write(bytes, error => error ? reject(protectedRuntimeRefused()) : resolve())
  })
}
