import * as Schema from 'effect/Schema'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'
import { requireCapture } from '../state/sqlite.js'
import type { SqlRow } from '../state/sqlite.js'
import type { CaptureTable } from './layout.js'

const roundTrip = <A, E>(schema: Schema.Codec<A, E>) => (value: unknown): E =>
  Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(value))

const codecs: Readonly<Record<string, (value: unknown) => unknown>> = {
  OrchestrationV2AppThreadJson: roundTrip(S.OrchestrationV2AppThreadJson),
  OrchestrationV2RunJson: roundTrip(S.OrchestrationV2RunJson),
  OrchestrationV2RunAttemptJson: roundTrip(S.OrchestrationV2RunAttemptJson),
  OrchestrationV2ExecutionNodeJson: roundTrip(S.OrchestrationV2ExecutionNodeJson),
  OrchestrationV2SubagentJson: roundTrip(S.OrchestrationV2SubagentJson),
  OrchestrationV2ProviderSessionJson: roundTrip(S.OrchestrationV2ProviderSessionJson),
  OrchestrationV2ProviderThreadJson: roundTrip(S.OrchestrationV2ProviderThreadJson),
  OrchestrationV2ProviderTurnJson: roundTrip(S.OrchestrationV2ProviderTurnJson),
  OrchestrationV2RuntimeRequestJson: roundTrip(S.OrchestrationV2RuntimeRequestJson),
  OrchestrationV2ConversationMessageJson: roundTrip(S.OrchestrationV2ConversationMessageJson),
  OrchestrationV2PlanArtifact: roundTrip(S.OrchestrationV2PlanArtifact),
  OrchestrationV2TurnItemJson: roundTrip(S.OrchestrationV2TurnItemJson),
  OrchestrationV2CheckpointScopeJson: roundTrip(S.OrchestrationV2CheckpointScopeJson),
  OrchestrationV2CheckpointJson: roundTrip(S.OrchestrationV2CheckpointJson),
  OrchestrationV2ContextHandoffJson: roundTrip(S.OrchestrationV2ContextHandoffJson),
  OrchestrationV2ContextTransferJson: roundTrip(S.OrchestrationV2ContextTransferJson),
}

/** Correlation uses SQL thread scope. A disagreeing embedded identity cannot
 * authorize borrowing that thread's question classification or answer copies.
 */
function checkIdentity(entry: CaptureTable, row: SqlRow, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const thread = entry.scope ? row[entry.scope] : undefined
  if (record.threadId !== undefined && typeof thread === 'string') {
    requireCapture(record.threadId === thread, 'capture_question_provenance_conflict')
  }
  const idColumn = entry.codec === 'OrchestrationV2RuntimeRequestJson' ? 'runtime_request_id'
    : entry.codec === 'OrchestrationV2TurnItemJson' ? 'turn_item_id'
      : entry.codec === 'OrchestrationV2ConversationMessageJson' ? 'message_id' : undefined
  if (idColumn) requireCapture(record.id === row[idColumn], 'capture_question_provenance_conflict')
}

/** Read the original shape before codecs discard native privacy metadata. */
export function rawStoredPayload(entry: CaptureTable, row: SqlRow): unknown {
  requireCapture(typeof row.payload_json === 'string', 'invalid_source_payload')
  requireCapture(Buffer.byteLength(row.payload_json, 'utf8') <= 1024 * 1024, 'capture_privacy_incomplete')
  const value: unknown = JSON.parse(row.payload_json)
  checkIdentity(entry, row, value)
  if (entry.codec !== 'application-event') {
    requireCapture(entry.codec && codecs[entry.codec], 'unsupported_source_codec')
    return value
  }
  requireCapture(typeof row.metadata_json === 'string', 'invalid_source_event_metadata')
  const metadata: unknown = JSON.parse(row.metadata_json)
  requireCapture(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'invalid_source_event_metadata')
  if (row.aggregate_kind === 'project') {
    return {
      sequence: row.sequence, eventId: row.event_id, aggregateKind: 'project', aggregateId: row.stream_id,
      occurredAt: row.occurred_at, commandId: row.command_id, causationEventId: row.causation_event_id,
      correlationId: row.correlation_id, type: row.event_type, payload: value, metadata,
    }
  }
  return {
    ...metadata, id: row.event_id, threadId: row.stream_id, type: row.event_type,
    occurredAt: row.occurred_at, payload: value,
  }
}

export function storedPayload(entry: CaptureTable, row: SqlRow): unknown {
  const value = rawStoredPayload(entry, row)
  if (entry.codec === 'application-event') {
    return row.aggregate_kind === 'project'
      ? roundTrip(S.ApplicationProjectEvent)(value) : roundTrip(S.OrchestrationV2DomainEventJson)(value)
  }
  requireCapture(entry.codec && codecs[entry.codec], 'unsupported_source_codec')
  return codecs[entry.codec]!(value)
}

/** Validate again after privacy projection, so a projected value cannot silently
 * change a typed field into an invalid sentinel. Excess properties are removed
 * by the original schemas, rather than a second session DTO.
 */
export function encodeStoredPayload(entry: CaptureTable, row: SqlRow, payload: unknown): SqlRow {
  if (entry.codec !== 'application-event') {
    requireCapture(entry.codec && codecs[entry.codec], 'unsupported_source_codec')
    return { ...row, payload_json: JSON.stringify(codecs[entry.codec]!(payload)) }
  }
  if (row.aggregate_kind === 'project') {
    const event = roundTrip(S.ApplicationProjectEvent)(payload)
    return { ...row, payload_json: JSON.stringify(event.payload), metadata_json: JSON.stringify(event.metadata) }
  }
  const event = roundTrip(S.OrchestrationV2DomainEventJson)(payload)
  // This is the original event-store's metadata envelope; never copy arbitrary
  // original metadata_json into secondary storage.
  const { id: _id, threadId: _thread, type: _type, occurredAt: _time, payload: data, ...metadata } = event
  return { ...row, payload_json: JSON.stringify(data),
    metadata_json: JSON.stringify({ ...metadata, applicationEventVersion: 2 }) }
}

export const attachmentArrayCodec = roundTrip(Schema.Array(S.ChatAttachment))
export const messageContextCodec = roundTrip(S.OrchestrationMessageContext)
