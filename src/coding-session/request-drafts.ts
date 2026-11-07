import { isAbsolute, relative, sep } from 'node:path'

import type { ExecutorSessionDecision, ExecutorSessionQuestion } from '@nessie/executor-protocol'

import type { Projector } from './projection.js'
import type { SessionRequestDraft } from './session-request-book.js'

/**
 * How a provider's prompt reads as a request to the owner, whichever provider
 * asked: every string through the session's projector (no credential, account
 * or host path survives), every path relative to the session's named folder
 * where it is inside it, and every field within the protocol's bounds.
 */

const LIMITS = { title: 300, justification: 4_000, command: 16_000, cwd: 1_000, diff: 32_000, input: 16_000 }

/** A path as the owner reads it: relative to the session folder (`.` for the folder), else projected. */
export const folderPath = (folder: string, path: unknown, projector: Projector): string => {
  if (typeof path !== 'string' || !path) return '.'
  if (!isAbsolute(path)) return projector.line(path, LIMITS.cwd) || '.'
  const inside = relative(folder, path)
  if (inside === '') return '.'
  if (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) {
    return projector.line(inside.split(sep).join('/'), LIMITS.cwd)
  }
  return projector.line(path, LIMITS.cwd)
}

const firstLine = (text: string): string => text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? ''

export const commandDraft = (input: {
  projector: Projector; folder: string; command: string; cwd?: unknown; justification?: unknown
  decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const command = input.projector.text(input.command, LIMITS.command)
  return {
    kind: 'command', title: input.projector.line(`Run ${firstLine(command) || 'a command'}`, LIMITS.title),
    command, cwd: folderPath(input.folder, input.cwd, input.projector), decisions: input.decisions,
    ...justified(input.projector, input.justification),
  }
}

export type FileChange = { path: string; change: 'add' | 'update' | 'delete' | 'move' }

export const fileChangeDraft = (input: {
  projector: Projector; folder: string; files: { path: unknown; change: FileChange['change'] }[]; diff?: unknown
  justification?: unknown; decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const files = input.files.slice(0, 64).map((file) => ({
    path: folderPath(input.folder, file.path, input.projector), change: file.change,
  }))
  const title = files.length === 1 ? `${files[0]!.change === 'add' ? 'Create' : files[0]!.change === 'delete'
    ? 'Delete' : 'Edit'} ${files[0]!.path}` : `Edit ${input.files.length} files`
  return {
    kind: 'file_change', title: input.projector.line(title, LIMITS.title), files, decisions: input.decisions,
    ...(typeof input.diff === 'string' && input.diff ? { diff: input.projector.text(input.diff, LIMITS.diff) } : {}),
    ...justified(input.projector, input.justification),
  }
}

export const permissionDraft = (input: {
  projector: Projector; tool: string; input: unknown; title?: string; justification?: unknown
  decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const tool = input.projector.line(input.tool, 200) || 'a tool'
  const rendered = input.input === undefined ? '' : JSON.stringify(input.input, null, 2) ?? ''
  return {
    kind: 'permission', title: input.projector.line(input.title ?? `Use ${tool}`, LIMITS.title), tool,
    ...(rendered ? { input: input.projector.text(rendered, LIMITS.input) } : {}), decisions: input.decisions,
    ...justified(input.projector, input.justification),
  }
}

export const questionDraft = (input: {
  projector: Projector; title?: string; justification?: unknown
  questions: { id: string; header?: unknown; question: unknown; options: { label: unknown; description?: unknown }[]
    multiSelect: boolean; allowCustomAnswer: boolean; secret: boolean }[]
  decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const questions: ExecutorSessionQuestion[] = input.questions.slice(0, 8).map((question) => {
    const header = input.projector.line(question.header, 120)
    return {
      id: question.id.slice(0, 160), ...(header ? { header } : {}),
      question: input.projector.text(question.question, 4_000) || 'Question',
      options: question.options.slice(0, 12).flatMap((option) => {
        const label = input.projector.line(option.label, 200)
        const description = input.projector.text(option.description, 1_000)
        return label ? [{ label, ...(description ? { description } : {}) }] : []
      }),
      multiSelect: question.multiSelect, allowCustomAnswer: question.allowCustomAnswer, secret: question.secret,
    }
  })
  const only = questions.length === 1 ? questions[0] : undefined
  return {
    kind: 'question',
    title: input.projector.line(input.title ?? only?.question ?? `${questions.length} questions`, LIMITS.title) || 'A question',
    questions, decisions: input.decisions, ...justified(input.projector, input.justification),
  }
}

const justified = (projector: Projector, value: unknown): { justification?: string } => {
  const text = projector.text(value, LIMITS.justification)
  return text ? { justification: text } : {}
}
