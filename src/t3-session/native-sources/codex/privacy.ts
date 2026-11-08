import { RequestPrivacy } from '@nessie/t3-session-source/engine'
import { requireCodex } from './identity.js'
import { codexRecord, type CodexRolloutRecord } from './rollout.js'

const UNKNOWN_VALUE = '[WITHHELD:UNKNOWN_QUESTION_PRIVACY]'
const PRIVATE_VALUE = '[REDACTED]'
const QUESTION_TOOLS = new Set(['request_user_input', 'functions.request_user_input'])
const callTypes = new Set(['function_call', 'custom_tool_call'])
const resultTypes = new Set(['function_call_output', 'custom_tool_call_output'])

/** One instance per exact captured native history, with a complete preflight before publication.
 * Uses the pinned original secret-tool registry/projector. No value/content matching.
 */
export class CodexHistoryPrivacy {
  private readonly calls = new Map<string, { name: string; questionMarker?: string }>()
  private readonly project = RequestPrivacy.createRequestPrivacyProjector()
  private bytes = 0
  private ready = false

  observe(record: CodexRolloutRecord): void {
    requireCodex(!this.ready, 'codex_privacy_already_complete')
    if (record.type !== 'response_item') return
    const item = record.payload
    if (!callTypes.has(String(item.type))) return
    requireCodex(typeof item.call_id === 'string' && typeof item.name === 'string', 'codex_call_identity_missing')
    const previous = this.calls.get(item.call_id)
    const questionMarker = QUESTION_TOOLS.has(item.name) ? this.questionMarker(item) : undefined
    requireCodex(!previous || (previous.name === item.name && previous.questionMarker === questionMarker),
      'codex_call_identity_conflict')
    if (!previous) {
      this.bytes += Buffer.byteLength(item.call_id) + Buffer.byteLength(item.name)
      requireCodex(this.calls.size < 8192 && this.bytes <= 256 * 1024, 'codex_privacy_capacity')
      this.calls.set(item.call_id, { name: item.name, questionMarker })
    }
    const projected = this.project(item)
    requireCodex(codexRecord(projected)?.privacy !== 'request_projection_unavailable', 'codex_privacy_incomplete')
  }

  complete(): void { this.ready = true }

  private questionInput(item: Record<string, unknown>): Record<string, unknown> {
    const input = item.arguments ?? item.input
    let value = input
    if (typeof input === 'string') {
      try { value = JSON.parse(input) } catch { requireCodex(false, 'codex_question_input_invalid') }
    }
    const fields = codexRecord(value)
    requireCodex(fields && Array.isArray(fields.questions), 'codex_question_input_invalid')
    return fields
  }

  private questionMarker(item: Record<string, unknown>): string | undefined {
    const { questions } = this.questionInput(item)
    const identities = new Map<string, unknown>()
    const masks = (questions as unknown[]).map(question => {
      const fields = codexRecord(question)
      requireCodex(fields && typeof fields.id === 'string' &&
        (fields.isSecret === undefined || typeof fields.isSecret === 'boolean'), 'codex_question_input_invalid')
      requireCodex(!identities.has(fields.id) || identities.get(fields.id) === fields.isSecret,
        'codex_question_classification_conflict')
      identities.set(fields.id, fields.isSecret)
      return fields.isSecret
    })
    return masks.length === 0 || masks.includes(undefined) ? UNKNOWN_VALUE
      : masks.includes(true) ? PRIVATE_VALUE : undefined
  }

  private questionDescriptor(item: Record<string, unknown>): unknown {
    const fields = this.questionInput(item)
    const questions = (fields.questions as unknown[]).map(question => {
      const value = codexRecord(question)!
      const marker = value.isSecret === false ? undefined : value.isSecret === true ? PRIVATE_VALUE : UNKNOWN_VALUE
      const descriptor: Record<string, unknown> = {}
      for (const key of ['id', 'header', 'question', 'isOther', 'isSecret', 'optional', 'multiple']) {
        if (Object.hasOwn(value, key)) {
          requireCodex(typeof value[key] === (['id', 'header', 'question'].includes(key) ? 'string' : 'boolean'),
            'codex_question_input_invalid')
          descriptor[key] = value[key]
        }
      }
      if (Object.hasOwn(value, 'initialAnswer')) descriptor.initialAnswer = marker ?? value.initialAnswer
      if (Array.isArray(value.options)) descriptor.options = value.options.map(option => {
        const original = codexRecord(option)
        requireCodex(original, 'codex_question_input_invalid')
        for (const key of ['label', 'description']) requireCodex(!Object.hasOwn(original, key) ||
          typeof original[key] === 'string', 'codex_question_input_invalid')
        return Object.fromEntries(['label', 'description', 'value', 'preview'].filter(key => Object.hasOwn(original, key))
          .map(key => [key, marker && (key === 'value' || key === 'preview') ? marker : original[key]]))
      })
      return descriptor
    })
    return typeof (item.arguments ?? item.input) === 'string' ? JSON.stringify({ questions }) : { questions }
  }

  apply(record: CodexRolloutRecord): CodexRolloutRecord {
    requireCodex(this.ready, 'codex_privacy_preflight_required')
    if (record.type !== 'response_item') return record
    const item = record.payload
    const call = typeof item.call_id === 'string' ? this.calls.get(item.call_id) : undefined
    let payload = item
    if (callTypes.has(String(item.type)) && typeof item.name === 'string' && QUESTION_TOOLS.has(item.name)) {
      payload = { ...item, [item.type === 'function_call' ? 'arguments' : 'input']: this.questionDescriptor(item) }
    } else if (resultTypes.has(String(item.type))) {
      const marker = !call ? '[WITHHELD:UNBOUND_TOOL_OUTPUT]' : call.questionMarker
      if (marker) payload = { ...item, output: marker }
    }
    // Keep source timestamps outside the projector's narrow sensitive metadata allowlist.
    const projected = this.project(payload)
    requireCodex(codexRecord(projected)?.privacy !== 'request_projection_unavailable', 'codex_privacy_incomplete')
    return { ...record, payload: projected as Record<string, unknown> }
  }
}
