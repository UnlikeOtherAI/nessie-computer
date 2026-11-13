import { z } from 'zod'
import { T3ExecutionBindingSchema } from './native-execution.js'
import { T3ExecutionDestinationEvidenceSchema } from '../execution-resource.js'

export const T3_EXECUTION_SHUTDOWN_PREPARATION_DOMAIN = 'nessie.t3.execution.shutdown-preparation.v1' as const
export const T3_EXECUTION_SHUTDOWN_DOMAIN = 'nessie.t3.execution.shutdown.v1' as const
export const T3_EXECUTION_SHUTDOWN_SLOT_DOMAIN = 'nessie.t3.execution.shutdown-slot.v1' as const
export const executionShutdownAdmissionBytes = (payload: string): Uint8Array =>
  new TextEncoder().encode(`${T3_EXECUTION_SHUTDOWN_DOMAIN}\n${payload}`)
const id = z.string().min(1).max(256)
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const millis = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const T3ExecutionShutdownObservationSchema = z.object({
  version: z.literal(1), observedAtMs: millis, selectionAtMs: millis, authorityDigest: sha,
  targets: z.array(z.object({ threadId: id, projectId: id, inputDigest: sha }).strict()).max(256),
  effects: z.array(z.object({ threadId: id, sourceRunId: id, effectId: id, commandId: id,
    existingRowDigest: sha.nullable() }).strict()).max(256),
}).strict().refine(value => value.observedAtMs >= value.selectionAtMs
  && value.observedAtMs < value.selectionAtMs + 5000
  && new Set(value.targets.map(target => target.threadId)).size === value.targets.length
  && new Set(value.effects.map(effect => effect.threadId)).size === value.effects.length
  && value.effects.every(effect => value.targets.some(target => target.threadId === effect.threadId)
    && effect.effectId === `effect:restart-continuation:${effect.sourceRunId}`
    && effect.commandId === `command:restart-prepare:${effect.sourceRunId}`))
const base = z.object({ version: z.literal(1), action: z.literal('prepare-shutdown'), binding: T3ExecutionBindingSchema,
  acceptedGraphNonce: hex, slotId: hex, evidence: T3ExecutionDestinationEvidenceSchema,
  observation: T3ExecutionShutdownObservationSchema, nonce: hex, issuedAtMs: millis, expiresAtMs: millis,
}).strict()
const recognized = (value: z.infer<typeof base>) => value.expiresAtMs > value.issuedAtMs
  && value.issuedAtMs >= value.observation.observedAtMs
  && value.expiresAtMs <= value.observation.selectionAtMs + 5000
export const T3ExecutionShutdownPreparationPayloadSchema = base.refine(value => recognized(value)
  && value.nonce === value.slotId && value.issuedAtMs === value.observation.observedAtMs)
export const T3ExecutionShutdownAdmissionSchema = base.extend({ issuerKeyId: hex,
  preparationReceiptDigest: sha }).refine(recognized)
export type T3ExecutionShutdownObservation = z.infer<typeof T3ExecutionShutdownObservationSchema>
export type T3ExecutionShutdownPreparation = z.infer<typeof T3ExecutionShutdownPreparationPayloadSchema>
export type T3ExecutionShutdownAdmission = z.infer<typeof T3ExecutionShutdownAdmissionSchema>
