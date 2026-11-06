import { z } from 'zod'

/**
 * What a coding session stopped to ask the person who owns it: approve a
 * command or a file change, allow a tool, answer a question, or supply a
 * secret. The executor reads these from the provider it drives (Codex
 * app-server requests, Claude Code permission prompts and AskUserQuestion, and
 * the executor's own `request_secret` tool), and the owner answers them from
 * the session's page in Nessie.
 *
 * A request is identified by the executor's opaque `id`, never by its text.
 * It is answerable only while `status` is `pending` and `answerable` is true:
 * a session found already open on the computer belongs to its own client (the
 * Codex app, a terminal), so the executor can say it is waiting on approval
 * but cannot answer for that client.
 */

export const EXECUTOR_SESSION_REQUEST_MAXIMUM = 16

export const ExecutorSessionRequestKindSchema = z.enum(['command', 'file_change', 'permission', 'question', 'secret'])
export type ExecutorSessionRequestKind = z.infer<typeof ExecutorSessionRequestKindSchema>

/** How an approval is answered. `cancel` declines and stops the turn. */
export const ExecutorSessionDecisionSchema = z.enum(['accept', 'accept_for_session', 'decline', 'cancel'])
export type ExecutorSessionDecision = z.infer<typeof ExecutorSessionDecisionSchema>

export const ExecutorSessionRequestStatusSchema = z.enum(['pending', 'answered', 'cancelled', 'expired'])
export type ExecutorSessionRequestStatus = z.infer<typeof ExecutorSessionRequestStatusSchema>

const Text = (max: number) => z.string().max(max)

export const ExecutorSessionQuestionOptionSchema = z.object({
  label: z.string().min(1).max(200),
  description: Text(1_000).optional(),
}).strict()

export const ExecutorSessionQuestionSchema = z.object({
  id: z.string().min(1).max(160),
  /** A short tag above the question ("Database"). */
  header: Text(120).optional(),
  question: z.string().min(1).max(4_000),
  options: z.array(ExecutorSessionQuestionOptionSchema).max(12),
  multiSelect: z.boolean(),
  /** The person may type their own answer instead of, or beside, an option. */
  allowCustomAnswer: z.boolean(),
  /** The answer is masked while typed and never shown again. */
  secret: z.boolean(),
}).strict()
export type ExecutorSessionQuestion = z.infer<typeof ExecutorSessionQuestionSchema>

export const ExecutorSessionFileChangeSchema = z.object({
  /** Relative to the session's named folder; never an absolute host path. */
  path: z.string().min(1).max(1_000),
  change: z.enum(['add', 'update', 'delete', 'move']),
}).strict()

export const ExecutorSessionRequestSchema = z.object({
  id: z.string().min(1).max(160),
  kind: ExecutorSessionRequestKindSchema,
  status: ExecutorSessionRequestStatusSchema,
  /** Why it is no longer pending: `turn_interrupted`, `provider_exited`, `executor_restarted`, `answered_elsewhere`. */
  reason: z.string().regex(/^[a-z0-9_]{1,100}$/u).optional(),
  answerable: z.boolean(),
  openedAt: z.string().datetime(),
  /** One line a person reads first: "Run pnpm test", "Edit 3 files", "Use WebFetch". */
  title: z.string().min(1).max(300),
  /** Why the agent says it needs this, in its own words. */
  justification: Text(4_000).optional(),
  /** `command`: the exact command line and the folder it runs in, relative to the named folder. */
  command: Text(16_000).optional(),
  cwd: Text(1_000).optional(),
  /** `file_change`: what changes, and a unified diff when the provider gave one. */
  files: z.array(ExecutorSessionFileChangeSchema).max(64).optional(),
  diff: Text(32_000).optional(),
  /** `permission`: the tool asked for and a readable rendering of its input. */
  tool: Text(200).optional(),
  input: Text(16_000).optional(),
  /** `question`: asked together and answered together. */
  questions: z.array(ExecutorSessionQuestionSchema).max(8).optional(),
  /**
   * `secret`: what is asked for and where the executor will write it — a file
   * relative to the named folder, created owner-only — so the value never
   * enters the conversation. `envName` names the variable when it is a `.env`
   * entry.
   */
  secretName: Text(200).optional(),
  destination: Text(1_000).optional(),
  envName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u).optional(),
  /** The approval answers this provider accepts, in the order to offer them. */
  decisions: z.array(ExecutorSessionDecisionSchema).max(4).optional(),
}).strict()
export type ExecutorSessionRequest = z.infer<typeof ExecutorSessionRequestSchema>

/**
 * What a session's list row says about the person it is waiting on, without
 * any of the request's content: lists are read by people the session is
 * shared with, and only its page shows what is asked.
 */
export const ExecutorSessionPendingSummarySchema = z.object({
  kind: z.enum(['approval', 'question', 'secret']),
  count: z.number().int().min(1).max(EXECUTOR_SESSION_REQUEST_MAXIMUM),
  answerable: z.boolean(),
  since: z.string().datetime(),
}).strict()
export type ExecutorSessionPendingSummary = z.infer<typeof ExecutorSessionPendingSummarySchema>

/** One answer to one pending request. Exactly one of the three shapes is used, by kind. */
export const ExecutorSessionAnswerSchema = z.object({
  requestId: z.string().min(1).max(160),
  /** `command`, `file_change`, `permission`. */
  decision: ExecutorSessionDecisionSchema.optional(),
  /** Feedback sent back with a decline, so the agent can change course. */
  feedback: Text(8_000).optional(),
  /** `question`: every question's chosen option labels and/or typed text. */
  answers: z.array(z.object({
    questionId: z.string().min(1).max(160),
    values: z.array(z.string().min(1).max(4_000)).min(1).max(12),
  }).strict()).max(8).optional(),
  /** `secret`: the value, delivered once and never stored readable. */
  secret: z.string().min(1).max(16_000).optional(),
}).strict().superRefine((value, ctx) => {
  const shapes = [value.decision !== undefined, value.answers !== undefined, value.secret !== undefined]
  if (shapes.filter(Boolean).length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'An answer carries exactly one of decision, answers or secret.' })
  }
  if (value.feedback !== undefined && value.decision !== 'decline') {
    ctx.addIssue({ code: 'custom', message: 'Feedback accompanies only a decline.' })
  }
})
export type ExecutorSessionAnswer = z.infer<typeof ExecutorSessionAnswerSchema>

/** Pending requests are listed before settled ones, newest settled last. */
export const ExecutorSessionRequestListSchema = z.array(ExecutorSessionRequestSchema)
  .max(EXECUTOR_SESSION_REQUEST_MAXIMUM)

export const summarizePendingRequests = (
  requests: readonly ExecutorSessionRequest[],
): ExecutorSessionPendingSummary | undefined => {
  const pending = requests.filter((request) => request.status === 'pending')
  if (!pending.length) return undefined
  const first = pending.reduce((earliest, request) => request.openedAt < earliest.openedAt ? request : earliest)
  const kind = pending.some((request) => request.kind === 'secret') ? 'secret'
    : pending.some((request) => request.kind === 'question') ? 'question' : 'approval'
  return {
    kind,
    count: Math.min(pending.length, EXECUTOR_SESSION_REQUEST_MAXIMUM),
    answerable: pending.some((request) => request.answerable),
    since: first.openedAt,
  }
}
