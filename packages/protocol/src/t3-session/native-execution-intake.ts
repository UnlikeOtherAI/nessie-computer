import { z } from 'zod'
import { T3ExecutionIssuerDescriptorSchema, T3ExecutionReceiptSchema, T3ExecutionSignedAdmissionSchema,
  T3_EXECUTION_RESERVATION_DOMAIN, T3_EXECUTION_PREPARATION_DOMAIN, T3_EXECUTION_ASSOCIATION_DOMAIN,
} from './native-execution.js'

const id = z.string().regex(/^[a-f0-9]{64}$/u)
export const T3NativeExecutionPhaseInputSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('reserve'), graphId: id }).strict(),
  z.object({ phase: z.literal('launch'), reservationId: id, preparationReceipt: T3ExecutionReceiptSchema }).strict(),
  z.object({ phase: z.literal('associate'), reservationId: id,
    providerSessionId: z.string().min(1).max(512) }).strict(),
])
export type T3NativeExecutionPhaseInput = z.infer<typeof T3NativeExecutionPhaseInputSchema>
export const T3NativeExecutionFrameInputSchema = z.object({
  reservationId: id, frameReceipt: T3ExecutionReceiptSchema,
}).strict()
export type T3NativeExecutionFrameInput = z.infer<typeof T3NativeExecutionFrameInputSchema>

/** Finite protected-child messages. No caller actor, request, binding, key,
 * homes, frame bytes or raw method/hash selector travels through this port.
 */
const phase = z.object({ operation: z.literal('execution.phase'), input: T3NativeExecutionPhaseInputSchema }).strict()
const frame = z.object({ operation: z.literal('execution.frame'), input: T3NativeExecutionFrameInputSchema }).strict()
const receipt = z.object({ operation: z.literal('execution.receipt'), receipt: T3ExecutionReceiptSchema }).strict()
export const T3NativeExecutionOperationSchema = z.discriminatedUnion('operation', [phase, frame, receipt])
export type T3NativeExecutionOperation = z.infer<typeof T3NativeExecutionOperationSchema>

const envelope = z.object({ executorId: z.string().uuid(),
  connectionEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u), observedAt: z.string().datetime(),
  signature: z.string().min(32).max(256),
}).strict()
const originalOperation = envelope.extend({ environmentId: z.string().min(1).max(512),
  correlationId: z.string().min(1).max(512), relayHmac: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u),
}).strict()
export const T3NativeExecutionIntakeSchema = z.discriminatedUnion('operation', [
  originalOperation.extend(phase.shape), originalOperation.extend(frame.shape), originalOperation.extend(receipt.shape),
  envelope.extend({ operation: z.literal('execution.issuer.offer'), descriptor: T3ExecutionIssuerDescriptorSchema }),
  envelope.extend({ operation: z.literal('execution.issuer.proof'), receipt: T3ExecutionReceiptSchema }),
  envelope.extend({ operation: z.literal('execution.issuer.pending') }),
])
export type T3NativeExecutionIntake = z.infer<typeof T3NativeExecutionIntakeSchema>
export type T3NativeExecutionOperationIntake = Extract<T3NativeExecutionIntake,
  { operation: T3NativeExecutionOperation['operation'] }>
export const T3NativeExecutionReceiptAcceptedSchema = z.object({ reservationId: id,
  domain: z.enum([T3_EXECUTION_RESERVATION_DOMAIN, T3_EXECUTION_PREPARATION_DOMAIN, T3_EXECUTION_ASSOCIATION_DOMAIN]),
  expiresAt: z.string().datetime(),
}).strict()
export type T3NativeExecutionReceiptAccepted = z.infer<typeof T3NativeExecutionReceiptAcceptedSchema>
export const T3NativeExecutionOperationResultSchema = z.union([
  T3ExecutionSignedAdmissionSchema, T3NativeExecutionReceiptAcceptedSchema,
])
export type T3NativeExecutionOperationResult = z.infer<typeof T3NativeExecutionOperationResultSchema>
