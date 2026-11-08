import { RequestPrivacy } from '@nessie/t3-session-source/engine'
import { requireCapture } from '../state/sqlite.js'
import type { SqlRow } from '../state/sqlite.js'
import type { T3SourceSnapshot } from './snapshot.js'
import { rawStoredPayload, storedPayload, encodeStoredPayload,
  attachmentArrayCodec, messageContextCodec } from './original-codecs.js'
import { CaptureQuestions } from './questions.js'
import type { CaptureTable } from './layout.js'
import type { RetainedReadScope } from '../ownership/continuity.js'
import { SourceContracts as S } from '@nessie/t3-session-source/engine'

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** One registered tool correlation projector per original thread, retained over all
 * complete passes. It caches only bounded IDs, never secret values. Each call
 * sees one stored record, not a capped concatenation of a huge transcript.
 */
export class CapturePrivacy {
  private readonly questions = new CaptureQuestions()
  private ready = false
  private started = false
  private readonly projectors = new Map<string,
    ReturnType<typeof RequestPrivacy.createRequestPrivacyProjector>>()

  private projector(scope: string): (value: unknown) => unknown {
    let projector = this.projectors.get(scope)
    if (!projector) {
      requireCapture(this.projectors.size < 100_000, 'capture_privacy_scope_capacity')
      projector = RequestPrivacy.createRequestPrivacyProjector()
      this.projectors.set(scope, projector)
    }
    const active = projector
    return (value: unknown): unknown => {
      const result = active(value)
      requireCapture(recordOf(result)?.privacy !== 'request_projection_unavailable', 'capture_privacy_incomplete')
      return result
    }
  }

  private scope(entry: CaptureTable, row: SqlRow): string {
    return JSON.stringify([row.aggregate_kind ?? 'thread', entry.scope ? row[entry.scope] : 'unscoped'])
  }

  async preflight(snapshot: T3SourceSnapshot, reads: RetainedReadScope): Promise<void> {
    requireCapture(!this.started, 'capture_privacy_requires_fresh_preflight')
    this.started = true
    for (const entry of snapshot.tables) {
      await reads.recheckSource()
      for (const row of snapshot.rows(entry)) {
        await recheckRow(reads, entry, row)
        if (!entry.codec && entry.name !== 'projection_thread_messages') continue
        const raw = entry.codec ? rawStoredPayload(entry, row) : this.legacyContext(row)
        const payload = this.questions.transform(raw, this.scope(entry, row))
        const project = this.projector(this.scope(entry, row))
        project(payload)
        this.observeNativeItems(payload, project)
        // Validate the original shape only AFTER structural classification.
        if (entry.codec) storedPayload(entry, row)
      }
    }
    this.questions.complete()
    // Validate every final projected row before the first destination INSERT.
    this.ready = true
    for (const entry of snapshot.tables) {
      for (const row of snapshot.rows(entry)) {
        await recheckRow(reads, entry, row)
        this.row(entry, row)
      }
    }
  }

  private legacyContext(row: SqlRow): unknown {
    if (typeof row.context_json !== 'string') return null
    requireCapture(Buffer.byteLength(row.context_json) <= 1024 * 1024, 'capture_privacy_incomplete')
    return JSON.parse(row.context_json)
  }

  private observeNativeItems(value: unknown, project: (value: unknown) => unknown): void {
    if (Array.isArray(value)) { for (const item of value) this.observeNativeItems(item, project); return }
    const record = recordOf(value)
    if (!record) return
    // Exact original dynamic_tool/nativeItemRef structures bridge the registered
    // native callId correlation. Never infer a tool from its title or prose.
    if (record.type === 'dynamic_tool' && RequestPrivacy.isSecretRequestTool(record.toolName)) {
      const native = recordOf(record.nativeItemRef)
      project({ toolName: record.toolName, callId: native?.nativeId, id: record.id })
    }
    for (const nested of Object.values(record)) this.observeNativeItems(nested, project)
  }

  private projectEntity(value: unknown, project: (value: unknown) => unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.projectEntity(item, project))
    const record = recordOf(value)
    if (!record) return value
    if (record.type === 'dynamic_tool') {
      const toolName = typeof record.toolName === 'string' ? record.toolName : null
      const item = RequestPrivacy.projectSecretRequestItem({ ...record, toolName,
        input: record.input, output: record.output })
      const native = recordOf(record.nativeItemRef)
      const projected = recordOf(project({ callId: native?.nativeId, input: item.input, output: item.output }))
      requireCapture(projected, 'capture_privacy_incomplete')
      return { ...item,
        input: RequestPrivacy.projectSecretRequestInput(toolName, projected.input),
        ...(record.output === undefined ? {} : {
          output: RequestPrivacy.projectSecretRequestOutput(toolName, projected.output),
        }),
      }
    }
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(record)) {
      if (key === 'responseCapability') {
        result[key] = { type: 'not_resumable', reason: 'Retained capture has no live callback affinity.' }
      } else if (key === 'nativeRequestRef') {
        result[key] = null
      } else if (key === 'answers') {
        result[key] = nested
      } else if (key === 'questions' && Array.isArray(nested)) {
        result[key] = nested
      } else {
        result[key] = this.projectEntity(nested, project)
      }
    }
    return result
  }

  row(entry: CaptureTable, source: SqlRow): SqlRow {
    requireCapture(this.ready, 'capture_privacy_preflight_required')
    const project = this.projector(this.scope(entry, source))
    const classify = (value: unknown) => this.questions.transform(value, this.scope(entry, source), question => {
      const result = RequestPrivacy.createRequestPrivacyProjector()(question)
      requireCapture(recordOf(result)?.privacy !== 'request_projection_unavailable', 'capture_privacy_incomplete')
      return result
    })
    let row = { ...source }
    if (entry.codec) {
      row = encodeStoredPayload(entry, row, this.projectEntity(classify(rawStoredPayload(entry, row)), project))
    }
    if (entry.name === 'orchestration_v2_legacy_imports') {
      // Fresh process/read layers plus reset durable markers invalidate BOTH caches.
      row.transcript_imported_at = null
      row.last_error = null
    }
    if (entry.name === 'projection_thread_messages') {
      if (typeof row.attachments_json === 'string') {
        row.attachments_json = JSON.stringify(attachmentArrayCodec(
          this.questions.projectAttachments(JSON.parse(row.attachments_json), this.scope(entry, row))))
      }
      if (typeof row.context_json === 'string') {
        const context = this.projectEntity(this.questions.projectContext(
          classify(this.legacyContext(row)), this.scope(entry, row)), project)
        row.context_json = JSON.stringify(messageContextCodec(context))
      }
    }
    return row
  }
}

export async function recheckRow(reads: RetainedReadScope, entry: CaptureTable, row: SqlRow): Promise<void> {
  await reads.recheckSource()
  if (entry.scope && row.aggregate_kind !== 'project' && typeof row[entry.scope] === 'string') {
    await reads.recheckThread(S.ThreadId.make(row[entry.scope] as string))
  }
  if (typeof row.target_thread_id === 'string') await reads.recheckThread(S.ThreadId.make(row.target_thread_id))
}
