import { requireCapture } from '../state/sqlite.js'

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Only opaque (source-thread, request, question) identities and explicit masks
 * survive preflight. Repeated IDs in different requests never share a mask.
 * A conflicting reuse inside one request cannot be disambiguated historically.
 */
export class CaptureQuestions {
  private readonly masks = new Map<string, boolean | undefined>()
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
    requireCapture([...this.masks.values()].every(mask => typeof mask === 'boolean'),
      'capture_question_classification_unknown')
  }

  /** With no projector this observes raw provenance and removes only the native
   * mask before tool correlation. With a projector it redacts before codecs run.
   * The bounded walk is per row; no transcript bodies are retained by the class.
   */
  transform(value: unknown, scope: string, projectQuestion?: (value: unknown) => unknown): unknown {
    let members = 32768
    const maskFor = (request: unknown, id: unknown, supplied?: unknown): boolean | undefined => {
      const key = this.key(scope, request, id)
      if (!projectQuestion) this.observe(key, supplied)
      const mask = this.masks.get(key)
      if (projectQuestion) requireCapture(typeof mask === 'boolean', 'capture_question_classification_unknown')
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
      const result = new Map<string, unknown>()
      for (const [key, nested] of Object.entries(record)) {
        if (key === 'questions' && questionItem) {
          requireCapture(Array.isArray(nested), 'capture_question_provenance_unknown')
          result.set(key, nested.map(question => {
            const fields = recordOf(question)
            requireCapture(fields, 'capture_question_provenance_unknown')
            const mask = maskFor(request, fields.id, fields.isSecret)
            const projected = projectQuestion && mask
              ? recordOf(projectQuestion({ ...fields, isSecret: true })) : fields
            requireCapture(projected, 'capture_privacy_incomplete')
            const { isSecret: _mask, ...publicFields } = projected
            if (projectQuestion && mask && Array.isArray(publicFields.options)) {
              publicFields.options = publicFields.options.map(option => {
                const fields = recordOf(option)
                requireCapture(fields, 'capture_question_provenance_unknown')
                const projectedOption = recordOf(projectQuestion({ ...fields, isSecret: true }))
                requireCapture(projectedOption, 'capture_privacy_incomplete')
                const { isSecret: _optionMask, ...publicOption } = projectedOption
                return publicOption
              })
            }
            return visit(publicFields, depth + 1)
          }))
        } else if ((key === 'answers' || key === 'attachmentsByQuestionId') && request !== undefined) {
          const answers = recordOf(nested)
          requireCapture(answers, 'capture_question_provenance_unknown')
          result.set(key, Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
            const mask = maskFor(request, id)
            // Attachment descriptors can contain entered filenames/previews. No
            // bytes are read; masked attachment delivery is not reconstructible.
            requireCapture(!(projectQuestion && mask && key === 'attachmentsByQuestionId' &&
              (!Array.isArray(answer) || answer.length > 0)), 'capture_masked_attachment_unsupported')
            return [id, projectQuestion && mask && key === 'answers' ? ['[REDACTED]'] : visit(answer, depth + 1)]
          })))
        } else {
          // An answer with no original request identity must never become public
          // merely because a different request reused its question ID.
          requireCapture(!(key === 'answers' && (runtimeRequest || embeddedAnswer) && request === undefined),
            'capture_question_provenance_unknown')
          // Only original event/entity slots convey provenance. Arbitrary tool
          // input with an "answers" or "requestId" key is ordinary tool content.
          const eventPayload = entity && key === 'payload' &&
            (record.type === 'turn-item.updated' || record.type === 'runtime-request.updated')
          result.set(key, visit(nested, depth + 1, eventPayload, questionItem && key === 'questionAnswer'))
        }
      }
      return Object.fromEntries(result)
    }
    return visit(value, 0, true)
  }
}
