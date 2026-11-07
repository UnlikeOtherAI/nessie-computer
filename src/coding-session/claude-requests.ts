import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { ExecutorSessionDecision } from '@nessie/executor-protocol'

import { claudeSessionRules } from './approval-scope.js'
import type { Projector } from './projection.js'
import { commandDraft, fileChangeDraft, permissionDraft, questionDraft } from './request-drafts.js'
import type { HostAnswer, SessionRequestDraft } from './session-request-book.js'
import { SESSION_SECRET_CLAUDE_TOOL } from './session-secret-mcp.js'

/**
 * Claude Code's permission prompts (`--permission-prompt-tool stdio`), as the
 * owner's requests. Verified against Claude Code 2.1.319: a prompt arrives as
 * a `control_request` whose request is `{subtype: 'can_use_tool', tool_name,
 * input, description?, permission_suggestions?, decision_reason?,
 * tool_use_id}`, and is answered by a `control_response` carrying
 * `{behavior: 'allow', updatedInput, updatedPermissions?}` or `{behavior:
 * 'deny', message, interrupt?}`. `AskUserQuestion` is answered by allowing it
 * with `answers` keyed by each question's text.
 *
 * The session's own `request_secret` tool is allowed without asking: the
 * secret request it opens is the owner's gate. Every other tool is a
 * `command` (Bash), a `file_change` (Write, Edit, MultiEdit, NotebookEdit) or
 * a `permission`. Accepting one for the session adds, for this session only
 * and never to a settings file, Claude's own concrete suggested rules or the
 * exact command, and extra directories only inside the reviewed folders
 * (`approval-scope.ts`); a prompt with nothing concrete to add does not offer
 * it.
 */

export type ClaudePrompt = {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  description?: string
  suggestions?: unknown[]
  decisionReason?: string
}

/** Why a prompt is denied while Nessie cannot put it to the owner: the words every prompt got before it could. */
export const CLAUDE_NO_OWNER_MESSAGE = 'No person is at this terminal to approve this, so it was denied.'

const APPROVAL: ExecutorSessionDecision[] = ['accept', 'accept_for_session', 'decline', 'cancel']
const TURN_DOWN: ExecutorSessionDecision[] = ['decline', 'cancel']
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const record = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

export const claudeControlResponse = (requestId: string, response: Record<string, unknown>): string => `${JSON.stringify({
  type: 'control_response', response: { subtype: 'success', request_id: requestId, response },
})}\n`

/** A `can_use_tool` request as this module reads it, or undefined for anything else. */
export const claudePromptOf = (event: Record<string, unknown>): ClaudePrompt | undefined => {
  const request = record(event.request) ? event.request : {}
  if (request.subtype !== 'can_use_tool' || typeof event.request_id !== 'string' || typeof request.tool_name !== 'string') {
    return undefined
  }
  return {
    requestId: event.request_id, toolName: request.tool_name, input: record(request.input) ? request.input : {},
    ...(typeof request.description === 'string' ? { description: request.description } : {}),
    ...(Array.isArray(request.permission_suggestions) ? { suggestions: request.permission_suggestions } : {}),
    ...(typeof request.decision_reason === 'string' ? { decisionReason: request.decision_reason } : {}),
  }
}

export type ClaudeRequestPlan =
  /** Answered at once, without the owner. */
  | { kind: 'allow'; line: string }
  | {
    kind: 'ask'
    draft: SessionRequestDraft
    /** The control response for the owner's answer, and whether it also stops the turn. */
    answer: (answer: HostAnswer) => { line: string; stopsTurn: boolean }
    /** The control response when the request ends unanswered. */
    withdraw: (reason: string) => string
  }

const deny = (requestId: string, message: string, interrupt = false): string => claudeControlResponse(requestId, {
  behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}),
})

const lines = (prefix: string, text: string): string => `${prefix}${text.split('\n').join(`\n${prefix}`)}`

/** What a file tool writes, as the owner reads it: every edit's old and new text, or the whole new content. */
const fileDiff = (input: Record<string, unknown>): string | undefined => {
  const edits = Array.isArray(input.edits) ? input.edits.filter(record) : [input]
  if (edits.length && edits.every((edit) => typeof edit.old_string === 'string' && typeof edit.new_string === 'string')) {
    return edits.map((edit) => `${lines('- ', edit.old_string as string)}\n${lines('+ ', edit.new_string as string)}`)
      .join('\n')
  }
  if (typeof input.content === 'string') return lines('+ ', input.content)
  if (typeof input.new_source === 'string') return lines('+ ', input.new_source)
  return undefined
}

const questionsOf = (input: Record<string, unknown>) => (Array.isArray(input.questions) ? input.questions : [])
  .filter(record).map((question, index) => ({
    id: `q${index + 1}`, text: typeof question.question === 'string' ? question.question : '',
    header: question.header, multiSelect: question.multiSelect === true,
    options: (Array.isArray(question.options) ? question.options : []).filter(record)
      .map((option) => ({ label: option.label, description: option.description })),
  }))

export const planClaudeRequest = (
  prompt: ClaudePrompt, projector: Projector, folder: string, roots: readonly string[] = [],
): ClaudeRequestPlan => {
  const { requestId, toolName, input } = prompt
  if (toolName === SESSION_SECRET_CLAUDE_TOOL) {
    return { kind: 'allow', line: claudeControlResponse(requestId, { behavior: 'allow', updatedInput: input }) }
  }
  const declined = (answer: HostAnswer) => ({
    line: deny(requestId, answer.feedback?.trim() || (answer.decision === 'cancel'
      ? 'The owner cancelled this and stopped the turn.' : 'The owner declined this.'), answer.decision === 'cancel'),
    stopsTurn: answer.decision === 'cancel',
  })
  const withdraw = (reason: string) => deny(requestId, `This request ended before the owner answered (${reason}).`)
  if (toolName === 'AskUserQuestion') {
    const questions = questionsOf(input)
    return {
      kind: 'ask',
      draft: questionDraft({
        projector, decisions: TURN_DOWN, questions: questions.map((question) => ({
          id: question.id, header: question.header, question: question.text, options: question.options,
          multiSelect: question.multiSelect, allowCustomAnswer: true, secret: false,
        })),
      }),
      answer: (answer) => {
        if (!answer.answers) return declined(answer)
        const values = new Map(answer.answers.map((entry) => [entry.questionId, entry.values.join(', ')]))
        const answers = Object.fromEntries(questions.map((question) => [question.text, values.get(question.id) ?? '']))
        return { line: claudeControlResponse(requestId, { behavior: 'allow', updatedInput: { ...input, answers } }), stopsTurn: false }
      },
      withdraw,
    }
  }
  const justification = prompt.description ?? prompt.decisionReason
  const rules = claudeSessionRules(prompt, folder, roots)
  const decisions = rules ? APPROVAL : APPROVAL.filter((decision) => decision !== 'accept_for_session')
  const draft = toolName === 'Bash' && typeof input.command === 'string'
    ? commandDraft({ projector, folder, command: input.command, justification, decisions })
    : FILE_TOOLS.has(toolName)
      ? fileChangeDraft({
        projector, folder, justification, decisions,
        files: [{ path: input.file_path ?? input.notebook_path, change: toolName === 'Write' && !(
          typeof input.file_path === 'string' && isAbsolute(input.file_path) && existsSync(input.file_path)) ? 'add' : 'update' }],
        diff: fileDiff(input),
      })
      : permissionDraft({ projector, tool: toolName, input, justification, decisions })
  return {
    kind: 'ask',
    draft,
    answer: (answer) => {
      if (answer.decision !== 'accept' && answer.decision !== 'accept_for_session') return declined(answer)
      return {
        line: claudeControlResponse(requestId, { behavior: 'allow', updatedInput: input,
          ...(answer.decision === 'accept_for_session' && rules ? { updatedPermissions: rules } : {}) }),
        stopsTurn: false,
      }
    },
    withdraw,
  }
}
