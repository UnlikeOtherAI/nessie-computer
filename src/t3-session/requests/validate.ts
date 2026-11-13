import type {
  OrchestrationV2Command, OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem,
  OrchestrationV2UserInputQuestion, ProviderSessionId,
} from '@nessie/t3-session-source/contracts'

export type T3RuntimeAnswer = Extract<OrchestrationV2Command, { type: 'runtime-request.respond' }>
export type T3RequestItem = Extract<OrchestrationV2TurnItem,
  { type: 'user_input_request' | 'approval_request' }>

export class T3AnswerValidationError extends Error {
  constructor(readonly code: 'request_not_pending' | 'request_mismatch' | 'provider_session_stale'
    | 'request_not_resumable' | 'answer_invalid' | 'canonical_secret_port_required') {
    super(code)
    this.name = 'T3AnswerValidationError'
  }
}
function refuse(code: T3AnswerValidationError['code'] = 'answer_invalid'): never {
  throw new T3AnswerValidationError(code)
}

const validateQuestion = (question: OrchestrationV2UserInputQuestion, value: unknown,
  present: boolean, hasAttachments: boolean): void => {
  // This guard complements the pre-codec provider privacy gate. It does not
  // reconstruct absent historical mask provenance or grant secret delivery.
  if ('isSecret' in question && question.isSecret === true) refuse('canonical_secret_port_required')
  if (!present) {
    if (question.required !== false && !hasAttachments) refuse()
    return
  }
  if (typeof value !== 'string' && !Array.isArray(value)) refuse()
  const values: readonly unknown[] = Array.isArray(value) ? value : [value]
  if (Array.isArray(value) && !question.multiSelect) refuse()
  if (values.some(entry => typeof entry !== 'string') || new Set(values).size !== values.length) refuse()
  if (values.length === 0 && question.required !== false && !hasAttachments) refuse()
  const offered = question.options.map(option => option.value ?? option.label)
  for (const entry of values) {
    if (offered.includes(entry as string)) continue
    if (question.allowCustomAnswer === false) refuse()
    if (entry === '' && question.required !== false && question.initialAnswer === undefined && !hasAttachments) refuse()
  }
}

/** Pure validation of already original-codec-decoded data, before engine resolution.
 * The engine still owns claims, expiry and the atomic resolution/provider effects.
 * Call against current engine records under its writer, never a browser snapshot.
 */
export const validateT3RuntimeAnswer = (input: {
  command: T3RuntimeAnswer
  request: OrchestrationV2RuntimeRequest
  item: T3RequestItem
  activeProviderSessionId: ProviderSessionId | null
}): void => {
  const { command, request, item } = input
  if (request.status !== 'pending') refuse('request_not_pending')
  if (command.requestId !== request.id || item.requestId !== request.id || item.threadId !== command.threadId
    || item.nodeId !== request.nodeId) refuse('request_mismatch')
  if (request.responseCapability.type === 'not_resumable') refuse('request_not_resumable')
  if (request.responseCapability.type === 'live'
    && request.responseCapability.providerSessionId !== input.activeProviderSessionId) refuse('provider_session_stale')
  if (item.type === 'approval_request') {
    if (request.kind !== item.requestKind) refuse('request_mismatch')
    if (request.responseCapability.type !== 'live') refuse('request_not_resumable')
    if (command.answers !== undefined || command.attachmentsByQuestionId !== undefined
      || command.decision === undefined || !item.options?.some(option => option.decision === command.decision)) refuse()
    if (command.feedback !== undefined && !request.responseCapability.supportsFeedback) refuse()
    return
  }
  if (request.kind !== 'user_input') refuse('request_mismatch')
  if (command.decision !== undefined || command.feedback !== undefined || command.answers === undefined) refuse()
  const ids = new Set(item.questions.map(question => question.id))
  if (ids.size !== item.questions.length || Object.keys(command.answers).some(id => !ids.has(id))) refuse()
  const attachments = command.attachmentsByQuestionId ?? {}
  if (Object.keys(attachments).some(id => !ids.has(id))) refuse()
  for (const question of item.questions) {
    const hasAttachments = Object.hasOwn(attachments, question.id) && (attachments[question.id]?.length ?? 0) > 0
    if (hasAttachments && question.allowCustomAnswer === false) refuse()
    const present = Object.hasOwn(command.answers, question.id)
    validateQuestion(question, present ? command.answers[question.id] : undefined, present, hasAttachments)
  }
}
