import { requireCapture } from '../state/sqlite.js'

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

// Machine-readable historical value sentinel, not an assertion of secrecy.
export const UNKNOWN_QUESTION_VALUE = '[WITHHELD:UNKNOWN_QUESTION_PRIVACY]'

/** Only opaque (source-thread, request, question) identities and explicit masks
 * survive preflight. Repeated IDs in different requests never share a mask.
 * A conflicting reuse inside one request cannot be disambiguated historically.
 */
export class CaptureQuestions {
  private readonly masks = new Map<string, boolean | undefined>()
  private readonly declared = new Set<string>()
  private readonly requests = new Map<string, Set<string>>()
  private readonly requestDeclarations = new Set<string>()
  private readonly copies = new Map<string, string>()
  private readonly attachments = new Map<string, Set<string>>()
  private bytes = 0

  private key(scope: string, request: unknown, question: unknown): string {
    requireCapture(typeof request === 'string' && request.length > 0 &&
      typeof question === 'string' && question.length > 0, 'capture_question_provenance_unknown')
    const key = JSON.stringify([scope, request, question])
    requireCapture(Buffer.byteLength(key) <= 1024, 'capture_privacy_incomplete')
    return key
  }

  private observe(key: string, mask: unknown): void {
    requireCapture(mask === undefined || typeof mask === 'boolean', 'capture_question_classification_unknown')
    if (!this.masks.has(key)) {
      this.bytes += Buffer.byteLength(key)
      requireCapture(this.masks.size < 8192 && this.bytes <= 256 * 1024, 'capture_privacy_incomplete')
      this.masks.set(key, mask)
    } else if (mask !== undefined) {
      const previous = this.masks.get(key)
      requireCapture(previous === undefined || previous === mask, 'capture_question_classification_conflict')
      this.masks.set(key, mask)
    }
  }

  complete(): void {
    requireCapture([...this.masks.keys()].every(key => this.declared.has(key)),
      'capture_question_provenance_unknown')
    for (const keys of this.attachments.values()) {
      const masks = [...keys].map(key => this.masks.get(key))
      requireCapture(!(masks.includes(false) && masks.some(mask => mask !== false)),
        'capture_attachment_classification_conflict')
    }
  }

  /** Fixed descriptor slots only; opaque references remain inert. */
  projectAttachments(value: unknown, scope: string, marker?: string): unknown {
    requireCapture(Array.isArray(value), 'capture_question_provenance_unknown')
    return value.map(attachment => {
      const fields = recordOf(attachment)
      requireCapture(fields, 'capture_question_provenance_unknown')
      const keys = this.attachments.get(JSON.stringify([scope, fields.id]))
      const masks = keys ? [...keys].map(key => this.masks.get(key)) : []
      const withheld = marker ?? (masks.includes(undefined) ? UNKNOWN_QUESTION_VALUE
        : masks.includes(true) ? '[REDACTED]' : undefined)
      if (!withheld) return attachment
      requireCapture(fields.type === 'file' || fields.type === 'image', 'capture_masked_attachment_unsupported')
      return { type: fields.type, id: fields.id, sizeBytes: fields.sizeBytes, name: withheld,
        mimeType: fields.type === 'image' ? 'image/x-withheld' : 'application/x-withheld' }
    })
  }

  projectContext(value: unknown, scope: string): unknown {
    const context = recordOf(value)
    if (!context || context.version !== 1 || !Array.isArray(context.records)) return value
    return { ...context, records: context.records.map(value => {
      const record = recordOf(value)
      if (!record || (record.kind !== 'file' && record.kind !== 'image')) return value
      const [descriptor] = this.projectAttachments([{ type: record.kind, id: record.attachmentId,
        name: record.name, mimeType: record.mimeType, sizeBytes: record.sizeBytes }], scope) as Record<string, unknown>[]
      requireCapture(descriptor, 'capture_question_provenance_unknown')
      if (descriptor.name === record.name && descriptor.mimeType === record.mimeType) return value
      return { ...record, label: descriptor.name, name: descriptor.name, mimeType: descriptor.mimeType }
    }) }
  }

  private observeAttachments(value: unknown, scope: string, questionKey: string): void {
    requireCapture(Array.isArray(value), 'capture_question_provenance_unknown')
    for (const attachment of value) {
      const id = recordOf(attachment)?.id
      requireCapture(typeof id === 'string', 'capture_question_provenance_unknown')
      const key = JSON.stringify([scope, id])
      let keys = this.attachments.get(key)
      if (!keys) {
        requireCapture(Buffer.byteLength(key) <= 2048 && this.attachments.size < 8192, 'capture_privacy_incomplete')
        this.bytes += Buffer.byteLength(key)
        keys = new Set(); this.attachments.set(key, keys)
      }
      if (!keys.has(questionKey)) { this.bytes += Buffer.byteLength(questionKey); keys.add(questionKey) }
      requireCapture(this.bytes <= 256 * 1024, 'capture_privacy_incomplete')
    }
  }

  private copyKey(scope: string, record: Record<string, unknown>): string | undefined {
    const native = recordOf(record.nativeItemRef)
    if (!native || typeof native.driver !== 'string' || typeof native.nativeId !== 'string' ||
      typeof record.providerTurnId !== 'string' || typeof record.providerThreadId !== 'string') return undefined
    return JSON.stringify([scope, 'native', record.providerThreadId, record.providerTurnId, native.driver, native.nativeId])
  }

  private rememberCopy(key: string, request: string): void {
    requireCapture(Buffer.byteLength(key) <= 2048, 'capture_privacy_incomplete')
    const previous = this.copies.get(key)
    requireCapture(previous === undefined || previous === request, 'capture_question_provenance_conflict')
    if (previous !== undefined) return
    this.bytes += Buffer.byteLength(key) + Buffer.byteLength(request)
    requireCapture(this.copies.size < 8192 && this.bytes <= 256 * 1024, 'capture_privacy_incomplete')
    this.copies.set(key, request)
  }

  private requestMarker(request: string): string | undefined {
    const keys = this.requests.get(request)
    requireCapture(keys && this.requestDeclarations.has(request), 'capture_question_provenance_unknown')
    if ([...keys].some(key => this.masks.get(key) === undefined)) return UNKNOWN_QUESTION_VALUE
    return [...keys].some(key => this.masks.get(key) === true) ? '[REDACTED]' : undefined
  }

  /** With no projector this observes raw provenance and removes only the native
   * mask before tool correlation. With a projector it redacts before codecs run.
   * The bounded walk is per row; no transcript bodies are retained by the class.
   */
  transform(value: unknown, scope: string, projectQuestion?: (value: unknown) => unknown): unknown {
    let members = 32768
    const maskFor = (request: unknown, id: unknown, supplied?: unknown, declaration = false): boolean | undefined => {
      const key = this.key(scope, request, id)
      if (!projectQuestion) {
        this.observe(key, supplied)
        if (declaration) this.declared.add(key)
        const requestKey = JSON.stringify([scope, request])
        let keys = this.requests.get(requestKey)
        if (!keys) { keys = new Set(); this.requests.set(requestKey, keys) }
        keys.add(key)
      }
      const mask = this.masks.get(key)
      if (projectQuestion) requireCapture(this.declared.has(key), 'capture_question_provenance_unknown')
      return mask
    }
    const visit = (input: unknown, depth: number, entity = false, embeddedAnswer = false): unknown => {
      requireCapture(--members >= 0 && depth <= 64, 'capture_privacy_incomplete')
      if (Array.isArray(input)) return input.map(item => visit(item, depth + 1))
      const record = recordOf(input)
      if (!record) return input
      const questionItem = entity && record.type === 'user_input_request'
      const runtimeRequest = entity && (record.kind === 'user_input' || record.responseCapability !== undefined)
      const request = questionItem || embeddedAnswer ? record.requestId : runtimeRequest ? record.id : undefined
      if (embeddedAnswer) requireCapture(typeof request === 'string', 'capture_question_provenance_unknown')
      if (questionItem && record.questionAnswer !== undefined) {
        requireCapture(recordOf(record.questionAnswer)?.requestId === request, 'capture_question_provenance_conflict')
      }
      if (!projectQuestion && (questionItem || (runtimeRequest && record.kind === 'user_input'))) {
        this.key(scope, request, 'provenance')
        const requestKey = JSON.stringify([scope, request])
        if (questionItem) this.requestDeclarations.add(requestKey)
        if (!this.requests.has(requestKey)) {
          this.bytes += Buffer.byteLength(requestKey)
          requireCapture(this.requests.size < 8192 && this.bytes <= 256 * 1024, 'capture_privacy_incomplete')
          this.requests.set(requestKey, new Set())
        }
        const nativeKey = questionItem ? this.copyKey(scope, record) : undefined
        if (nativeKey) this.rememberCopy(nativeKey, requestKey)
        if (record.responseMode === 'message' || recordOf(record.responseCapability)?.type === 'message') {
          this.rememberCopy(JSON.stringify([scope, 'message', `async-answer:${String(request)}`]), requestKey)
        }
      }
      if (projectQuestion && entity && !questionItem) {
        const nativeKey = record.type === 'dynamic_tool' ? this.copyKey(scope, record) : undefined
        const messageId = record.type === 'user_message' ? record.messageId : record.role === 'user' ? record.id : undefined
        const copy = this.copies.get(nativeKey ?? '') ?? (typeof messageId === 'string'
          ? this.copies.get(JSON.stringify([scope, 'message', messageId])) : undefined)
        // Exact original Claude tool identity, not an interpretation of text.
        // A missing native tuple cannot borrow another request's public mask.
        const unboundQuestionTool = record.type === 'dynamic_tool' && record.toolName === 'AskUserQuestion' &&
          recordOf(record.nativeItemRef)?.driver === 'claude'
        const marker = copy ? this.requestMarker(copy) : unboundQuestionTool ? UNKNOWN_QUESTION_VALUE : undefined
        if (marker) return Object.fromEntries(Object.entries(record)
            .filter(([key]) => key !== 'context')
            .map(([key, nested]) => [key,
              ['input', 'output', 'title', 'text', 'viewedImagePath'].includes(key) && nested !== null ? marker
                : key === 'attachments' ? this.projectAttachments(nested, scope, marker) : nested]))
      }
      const result = new Map<string, unknown>()
      for (const [key, nested] of Object.entries(record)) {
        if (projectQuestion && ((questionItem && key === 'title') ||
          (runtimeRequest && record.kind === 'user_input' && key === 'feedback')) && nested !== null) {
          result.set(key, this.requestMarker(JSON.stringify([scope, request])) ?? nested)
        } else if (key === 'questions' && questionItem) {
          requireCapture(Array.isArray(nested), 'capture_question_provenance_unknown')
          result.set(key, nested.map(question => {
            const fields = recordOf(question)
            requireCapture(fields, 'capture_question_provenance_unknown')
            const mask = maskFor(request, fields.id, fields.isSecret, true)
            const projected = projectQuestion && mask === true
              ? recordOf(projectQuestion({ ...fields, isSecret: true })) : fields
            requireCapture(projected, 'capture_privacy_incomplete')
            const { isSecret: _mask, ...publicFields } = projected
            if (projectQuestion && mask === undefined) {
              for (const field of ['header', 'question', 'initialAnswer']) {
                if (Object.hasOwn(publicFields, field)) publicFields[field] = UNKNOWN_QUESTION_VALUE
              }
            }
            if (projectQuestion && mask !== false && Array.isArray(publicFields.options)) {
              publicFields.options = publicFields.options.map(option => {
                const fields = recordOf(option)
                requireCapture(fields, 'capture_question_provenance_unknown')
                const projectedOption = mask === undefined
                  ? Object.fromEntries(Object.keys(fields).map(key => [key, UNKNOWN_QUESTION_VALUE]))
                  : recordOf(projectQuestion({ ...fields, isSecret: true }))
                requireCapture(projectedOption, 'capture_privacy_incomplete')
                const { isSecret: _optionMask, ...publicOption } = projectedOption
                return publicOption
              })
            }
            return visit(publicFields, depth + 1)
          }))
        } else if (['answers', 'attachmentsByQuestionId', 'questionTextById'].includes(key) && request !== undefined) {
          const answers = recordOf(nested)
          requireCapture(answers, 'capture_question_provenance_unknown')
          result.set(key, Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
            const mask = maskFor(request, id)
            const marker = mask === undefined ? UNKNOWN_QUESTION_VALUE : '[REDACTED]'
            if (!projectQuestion && key === 'attachmentsByQuestionId') {
              this.observeAttachments(answer, scope, this.key(scope, request, id))
            }
            if (projectQuestion && mask !== false && key === 'attachmentsByQuestionId') {
              return [id, this.projectAttachments(answer, scope, marker)]
            }
            if (projectQuestion && mask !== false && key === 'answers') {
              return [id, Array.isArray(answer) ? answer.map(() => marker) : marker]
            }
            if (projectQuestion && mask === undefined && key === 'questionTextById') return [id, marker]
            return [id, visit(answer, depth + 1)]
          })))
        } else if (projectQuestion && entity && key === 'attachments') {
          result.set(key, this.projectAttachments(nested, scope))
        } else if (projectQuestion && entity && key === 'context') {
          result.set(key, this.projectContext(nested, scope))
        } else {
          // An answer with no original request identity must never become public
          // merely because a different request reused its question ID.
          requireCapture(!(key === 'answers' && (runtimeRequest || embeddedAnswer) && request === undefined),
            'capture_question_provenance_unknown')
          // Only original event/entity slots convey provenance. Arbitrary tool
          // input with an "answers" or "requestId" key is ordinary tool content.
          const eventPayload = entity && key === 'payload' &&
            (record.type === 'turn-item.updated' || record.type === 'runtime-request.updated' ||
              record.type === 'message.updated')
          result.set(key, visit(nested, depth + 1, eventPayload, questionItem && key === 'questionAnswer'))
        }
      }
      return Object.fromEntries(result)
    }
    return visit(value, 0, true)
  }
}
