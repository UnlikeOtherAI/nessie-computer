import { isAbsolute, relative, sep } from 'node:path'

import type { ExecutorSessionDecision, ExecutorSessionQuestion } from '@nessie/executor-protocol'

import type { Projector } from './projection.js'
import type { SessionRequestDraft } from './session-request-book.js'

/**
 * How a provider's prompt reads as a request to the owner, whichever provider
 * asked: every string through the session's projector (no credential, account
 * or host path survives), every path relative to the session's named folder
 * where it is inside it, and every field within the protocol's bounds.
 *
 * Approving is the owner's decision about what they read, so a request whose
 * command, diff, input, files or folder had to be cut to fit — or a file
 * change whose content the provider did not give — offers only a decline or a
 * cancel, and its title says why. Nothing is approved that was not shown.
 */

const LIMITS = { title: 300, justification: 4_000, command: 16_000, cwd: 1_000, diff: 32_000, input: 16_000 }
const WHOLE = Number.MAX_SAFE_INTEGER

export const PARTIAL_TITLE = 'Shown in part, so it can only be declined: '

type Shown = { text: string; whole: boolean }

/** Projected, and cut to its limit only when it does not fit: `whole` says which. */
const shown = (projector: Projector, value: unknown, max: number, line = false): Shown => {
  const project = line ? projector.line : projector.text
  const whole = project(value, WHOLE)
  return whole.length <= max ? { text: whole, whole: true } : { text: project(value, max), whole: false }
}

/** A request the owner could not read whole offers only a decline or a cancel, and its title says so first. */
export const asShown = (draft: SessionRequestDraft, whole: boolean): SessionRequestDraft => {
  if (whole) return draft
  const turnDown = (draft.decisions ?? []).filter((decision) => decision === 'decline' || decision === 'cancel')
  const title = `${PARTIAL_TITLE}${draft.title}`
  return {
    ...draft, decisions: turnDown.length ? turnDown : ['decline'],
    title: title.length <= LIMITS.title ? title : `${title.slice(0, LIMITS.title - 1)}…`,
  }
}

const folderPathShown = (folder: string, path: unknown, projector: Projector): Shown => {
  if (typeof path !== 'string' || !path) return { text: '.', whole: true }
  const inside = isAbsolute(path) ? relative(folder, path) : undefined
  if (inside === '') return { text: '.', whole: true }
  const named = inside !== undefined && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)
    ? inside.split(sep).join('/') : path
  const result = shown(projector, named, LIMITS.cwd, true)
  return { text: result.text || '.', whole: result.whole }
}

/** A path as the owner reads it: relative to the session folder (`.` for the folder), else projected. */
export const folderPath = (folder: string, path: unknown, projector: Projector): string => (
  folderPathShown(folder, path, projector).text
)

const firstLine = (text: string): string => text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? ''

export const commandDraft = (input: {
  projector: Projector; folder: string; command: string; cwd?: unknown; justification?: unknown
  decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const command = shown(input.projector, input.command, LIMITS.command)
  const cwd = folderPathShown(input.folder, input.cwd, input.projector)
  return asShown({
    kind: 'command', title: input.projector.line(`Run ${firstLine(command.text) || 'a command'}`, LIMITS.title),
    command: command.text, cwd: cwd.text, decisions: input.decisions,
    ...justified(input.projector, input.justification),
  }, command.whole && cwd.whole && command.text !== '')
}

export type FileChange = { path: string; change: 'add' | 'update' | 'delete' | 'move'; diff?: string }

/**
 * One diff for several files, each under its path as the owner reads it, or
 * undefined when a new or changed file's content is missing.
 */
export const filesDiff = (changes: readonly FileChange[], label: (path: string) => string): string | undefined => {
  if (!changes.length || changes.some((change) => change.diff === undefined && (change.change === 'add'
    || change.change === 'update'))) return undefined
  return changes.map((change) => `--- ${label(change.path)} (${change.change})${change.diff ? `\n${change.diff}` : ''}`)
    .join('\n')
}

export const fileChangeDraft = (input: {
  projector: Projector; folder: string; files: { path: unknown; change: FileChange['change'] }[]; diff?: unknown
  justification?: unknown; decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const paths = input.files.slice(0, 64).map((file) => folderPathShown(input.folder, file.path, input.projector))
  const files = paths.map((path, index) => ({ path: path.text, change: input.files[index]!.change }))
  const title = files.length === 1 ? `${files[0]!.change === 'add' ? 'Create' : files[0]!.change === 'delete'
    ? 'Delete' : 'Edit'} ${files[0]!.path}` : `Edit ${input.files.length} files`
  const diff = typeof input.diff === 'string' && input.diff ? shown(input.projector, input.diff, LIMITS.diff) : undefined
  // A new or changed file's content is what an approval writes: without it, there is nothing to approve.
  const contentShown = diff?.whole ?? input.files.every((file) => file.change === 'delete' || file.change === 'move')
  return asShown({
    kind: 'file_change', title: input.projector.line(title, LIMITS.title), files, decisions: input.decisions,
    ...(diff ? { diff: diff.text } : {}),
    ...justified(input.projector, input.justification),
  }, input.files.length > 0 && input.files.length <= 64 && paths.every((path) => path.whole) && contentShown)
}

export const permissionDraft = (input: {
  projector: Projector; tool: string; input: unknown; title?: string; justification?: unknown
  decisions: ExecutorSessionDecision[]
}): SessionRequestDraft => {
  const tool = input.projector.line(input.tool, 200) || 'a tool'
  const rendered = input.input === undefined ? '' : JSON.stringify(input.input, null, 2) ?? ''
  const shownInput = rendered ? shown(input.projector, rendered, LIMITS.input) : undefined
  return asShown({
    kind: 'permission', title: input.projector.line(input.title ?? `Use ${tool}`, LIMITS.title), tool,
    ...(shownInput ? { input: shownInput.text } : {}), decisions: input.decisions,
    ...justified(input.projector, input.justification),
  }, shownInput?.whole ?? true)
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
